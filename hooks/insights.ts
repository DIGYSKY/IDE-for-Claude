// La conversation de la session et le tableau de bord « Claude Status » de la page.
import type { EngineInterface } from 'claude-code'

type $ = EngineInterface

// ---------- conversation ----------

export type ConvTool = { tool: string; label: string; isError?: boolean; out?: string; agentId?: string }
export type ConvItem = { i: number; role: 'user' | 'assistant'; text: string; tools?: ConvTool[]; kind?: 'summary' | 'command' }

const MAX_OUT = 1500
const MAX_TEXT = 60_000

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} caractères de plus)` : s)

/** Ce qu'un appel d'outil fait, en une ligne. */
export function toolLabel(cwd: string, tool: string, input: Record<string, unknown>): string {
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  const p = typeof input.file_path === 'string' ? rel(input.file_path) : typeof input.path === 'string' ? rel(input.path) : typeof input.notebook_path === 'string' ? rel(input.notebook_path) : ''
  const s = (v: unknown, n = 120) => String(v ?? '').split('\n')[0]!.slice(0, n)
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ ${tool === 'Write' ? 'écrit' : 'modifie'} ${p}`
    case 'Read':
      return `📖 lit ${p}`
    case 'Bash':
      return `⚙️ ${input.description ? s(input.description) + ' · ' : ''}${s(input.command)}`
    case 'Grep':
      return `🔎 cherche « ${s(input.pattern, 60)} »${p ? ' dans ' + p : ''}`
    case 'Glob':
      return `🔎 liste ${s(input.pattern, 60)}`
    case 'Agent':
    case 'Task':
      return `🧑‍🤝‍🧑 sous-agent : ${s(input.description || input.prompt, 80)}`
    case 'WebFetch':
      return `🌐 lit ${s(input.url)}`
    case 'WebSearch':
      return `🌐 cherche « ${s(input.query, 80)} »`
    case 'TodoWrite':
      return '📋 met à jour le plan'
    case 'Skill':
      return `🧩 skill ${s(input.skill || input.command, 60)}`
    default: {
      const short = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
      return `🔧 ${short}`
    }
  }
}

/** Le texte d'un message utilisateur sans ce que Claude Code y glisse pour le modèle. */
export function userText(raw: string): { text: string; kind?: 'summary' | 'command' } {
  let t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
    return { text: `${cmd[1]!.trim()}${args ? ' ' + args : ''}`, kind: 'command' }
  }
  const out = t.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
  if (out) return { text: out[1]!.replace(/\x1b\[[0-9;]*m/g, '').trim(), kind: 'command' }
  t = t.trim()
  if (/^This session is being continued from a previous conversation/.test(t)) return { text: t, kind: 'summary' }
  return { text: t }
}

/**
 * La conversation principale, de l'entrée `from` à la fin, prête pour la page.
 * `first` repère le début : s'il change (/clear, plus de 4096 entrées), la page recharge tout.
 */
export async function conversation($: $, from = 0) {
  const cwd = await $.session.cwd()
  const msgs = await $.session.messages()
  const items: ConvItem[] = []
  for (let i = Math.max(0, from); i < msgs.length; i++) {
    const m = msgs[i]!
    if (m.role === 'user') {
      const { text, kind } = userText(m.text)
      if (!text) continue
      items.push({ i, role: 'user', text: clip(text, MAX_TEXT), ...(kind ? { kind } : {}) })
      continue
    }
    const tools = m.toolUses.map(u => ({
      tool: u.tool,
      label: toolLabel(cwd, u.tool, u.input ?? {}),
      ...(u.isError ? { isError: true } : {}),
      ...(u.text ? { out: clip(u.text, MAX_OUT) } : {}),
      ...(u.agentId ? { agentId: u.agentId } : {}),
    }))
    if (!m.text && !tools.length) continue
    items.push({ i, role: 'assistant', text: clip(m.text, MAX_TEXT), ...(tools.length ? { tools } : {}) })
  }
  const head = msgs[0]
  return { total: msgs.length, first: head ? `${head.role}:${head.text.slice(0, 80)}` : '', from, items }
}

// ---------- coûts : les fichiers de session de Claude Code ----------

type ModelCost = {
  model: string
  input: number
  output: number
  thinking: number
  cacheRead: number
  cacheWrite: number
  web: number
  usd: number
}
export type SessionCostInfo = {
  id: string
  title?: string
  start?: number
  last: number
  usd: number | null
  linesAdded?: number
  linesRemoved?: number
  apiMs?: number
  toolMs?: number
  wallMs?: number
  models: ModelCost[]
  current?: boolean
}

/** La dernière ligne d'un type donné dans un fichier .jsonl, sans tout analyser. */
function lastLine(text: string, type: string): Record<string, unknown> | null {
  const at = text.lastIndexOf(`"type":"${type}"`)
  if (at < 0) return null
  const a = text.lastIndexOf('\n', at) + 1
  const b = text.indexOf('\n', at)
  try {
    return JSON.parse(text.slice(a, b < 0 ? undefined : b)) as Record<string, unknown>
  } catch {
    return null
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function sessionCostOf(id: string, text: string, mtimeMs: number): SessionCostInfo {
  const cs = lastLine(text, 'cost-state')
  const title = (lastLine(text, 'custom-title')?.customTitle ?? lastLine(text, 'ai-title')?.aiTitle) as string | undefined
  const info: SessionCostInfo = { id, last: mtimeMs, usd: null, models: [], ...(title ? { title } : {}) }
  if (!cs) {
    const first = text.match(/"timestamp":"([^"]+)"/)
    if (first) info.start = Date.parse(first[1]!)
    return info
  }
  info.usd = num(cs.totalCostUSD)
  info.start = num(cs.startTime) || undefined
  info.linesAdded = num(cs.totalLinesAdded)
  info.linesRemoved = num(cs.totalLinesRemoved)
  info.apiMs = num(cs.totalAPIDuration)
  info.toolMs = num(cs.totalToolDuration)
  info.wallMs = num(cs.totalDuration)
  const mu = (cs.modelUsage ?? {}) as Record<string, Record<string, unknown>>
  info.models = Object.entries(mu).map(([model, u]) => ({
    model,
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    thinking: num(u.thinkingTokens),
    cacheRead: num(u.cacheReadInputTokens),
    cacheWrite: num(u.cacheCreationInputTokens),
    web: num(u.webSearchRequests),
    usd: num(u.costUSD),
  }))
  return info
}

// un fichier déjà lu n'est relu que s'il a changé
// (la session en cours, qui grossit sans cesse, n'est relue qu'une fois toutes les 30 s)
const costCache = new Map<string, { mtimeMs: number; size: number; readAt: number; info: SessionCostInfo }>()

async function sessionsIn($: $, dir: string, since = 0): Promise<SessionCostInfo[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const out: SessionCostInfo[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.jsonl') || e.mtimeMs < since) continue
    const path = `${dir}/${e.name}`
    const hit = costCache.get(path)
    if (hit && ((hit.mtimeMs === e.mtimeMs && hit.size === e.size) || Date.now() - hit.readAt < 30_000)) {
      out.push(hit.info)
      continue
    }
    const text = await $.fs.read(path).catch(() => null)
    if (typeof text !== 'string') continue
    const info = sessionCostOf(e.name.slice(0, -6), text, e.mtimeMs)
    costCache.set(path, { mtimeMs: e.mtimeMs, size: e.size, readAt: Date.now(), info })
    out.push(info)
  }
  return out
}

async function claudeHome($: $) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
}

/** Le dossier des sessions du projet : celui qui contient le fichier de la session en cours. */
let projectDirFound: { id: string; dir: string } | null = null
async function projectDir($: $, cwd: string, id: string) {
  if (projectDirFound?.id === id) return projectDirFound.dir
  const root = `${await claudeHome($)}/projects`
  const guess = `${root}/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
  let dir: string | null = null
  if (await $.fs.exists(`${guess}/${id}.jsonl`).catch(() => false)) dir = guess
  else {
    for (const d of await $.fs.list(root).catch(() => [])) {
      if (d.kind !== 'dir') continue
      if (await $.fs.exists(`${root}/${d.name}/${id}.jsonl`).catch(() => false)) {
        dir = `${root}/${d.name}`
        break
      }
    }
    if (!dir && (await $.fs.exists(guess).catch(() => false))) dir = guess
  }
  if (dir) projectDirFound = { id, dir }
  return dir
}

// ---------- tableau de bord ----------

export type DashOptions = { effort?: string; planPrice?: number; changedFiles?: number }

/** Tout ce que le tableau de bord affiche, en une fois. */
export async function dashboard($: $, opts: DashOptions = {}) {
  const [cwd, id, model, turns] = await Promise.all([
    $.session.cwd(),
    $.session.id().catch(() => ''),
    $.session.model().catch(() => undefined),
    $.session.turns().catch(() => undefined),
  ])
  const usage =
    (await $.session.usage({ breakdown: 'summary' }).catch(() => null)) ?? (await $.session.usage().catch(() => null))
  const version = await $.session.version().catch(() => null)
  const identity = await $.session.identity().catch(() => null)

  const bd = usage?.context.breakdown
  const context = {
    tokens: usage?.context.tokens ?? null,
    window: usage?.context.window ?? null,
    percent: usage?.context.percent ?? null,
    ...(bd
      ? {
          categories: bd.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })),
          max: bd.rawMaxTokens,
          autoCompact: bd.isAutoCompactEnabled ? (bd.autoCompactThreshold ?? null) : null,
          memoryFiles: bd.memoryFiles.map(f => ({ path: f.path, tokens: f.tokens })),
          mcp: { count: bd.mcpTools.length, tokens: bd.mcpTools.reduce((a, t) => a + (t.isLoaded ? t.tokens : 0), 0) },
          skills: bd.skills ? { count: bd.skills.totalSkills, tokens: bd.skills.tokens } : null,
          last: bd.apiUsage,
        }
      : {}),
  }

  // les sessions du projet (la session en cours a son coût en direct)
  const dir = id ? await projectDir($, cwd, id) : null
  // copie : les fiches lues restent telles quelles dans le cache
  const sessions = (dir ? await sessionsIn($, dir) : []).map(s => ({ ...s }))
  let current = sessions.find(s => s.id === id)
  if (!current) {
    current = { id, last: Date.now(), usd: null, models: [] }
    sessions.push(current)
  }
  current.current = true
  if (usage?.cost) current.usd = usage.cost.usd
  if (usage?.startedAt) current.start = usage.startedAt
  current.last = Date.now()
  sessions.sort((a, b) => b.last - a.last)

  const projectTotal = sessions.reduce((a, s) => a + (s.usd ?? 0), 0)
  const byDay = new Map<string, number>()
  for (const s of sessions) {
    if (!s.usd) continue
    const day = new Date(s.last).toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + s.usd)
  }

  // ce mois-ci, tous projets confondus : de quoi comparer au prix de l'abonnement
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  let month: { usd: number; sessions: number; projects: number } | null = null
  const root = `${await claudeHome($)}/projects`
  const dirs = (await $.fs.list(root).catch(() => [])).filter(d => d.kind === 'dir')
  if (dirs.length) {
    month = { usd: 0, sessions: 0, projects: 0 }
    for (const d of dirs) {
      const path = `${root}/${d.name}`
      const list = path === dir ? sessions.filter(s => s.last >= monthStart) : await sessionsIn($, path, monthStart)
      const costly = list.filter(s => (s.usd ?? 0) > 0)
      if (!costly.length) continue
      month.projects++
      month.sessions += costly.length
      month.usd += costly.reduce((a, s) => a + (s.usd ?? 0), 0)
    }
  }

  return {
    at: Date.now(),
    cwd,
    session: {
      id,
      model: model ?? null,
      effort: opts.effort ?? null,
      turns: turns ?? null,
      version: version?.version ?? null,
      account: identity && 'kind' in identity ? (identity.kind ?? null) : null,
      plan: identity && 'organizationType' in identity ? (identity.organizationType ?? null) : null,
      changedFiles: opts.changedFiles ?? null,
    },
    context,
    limits: (usage?.rateLimits ?? []).map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : null })),
    current,
    project: {
      dir,
      total: projectTotal,
      sessions: sessions.slice(0, 200),
      count: sessions.length,
      days: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([day, usd]) => ({ day, usd })),
    },
    month,
    planPrice: opts.planPrice ?? null,
  }
}
