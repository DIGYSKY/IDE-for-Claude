import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Annotation, Change, HistFile, Idea, Mode, OpenFile, PlanItem, Project, Queued, ReviewItem, SavedCommand, Status, Turn } from '../types'
import { cutToks, langOf, start, tokenize } from './syntax'
import type { Kind, Tok } from './syntax'

const PANE = 'ide-for-claude'
const TITLE = 'IDE for Claude'
const MAX_BYTES = 1_000_000
const MAX_LINES = 3000

const fileAtom = atom({ plugin: 'ide-for-claude', key: 'file' } as const, null as OpenFile | null, { shape: 'file-2' })
const changesAtom = atom({ plugin: 'ide-for-claude', key: 'changes' } as const, [] as Change[], { shape: 'changes-2' })
const modeAtom = atom({ plugin: 'ide-for-claude', key: 'mode' } as const, 'view' as Mode, { shape: 'mode-1' })
const noticeAtom = atom({ plugin: 'ide-for-claude', key: 'notice' } as const, '', { shape: 'notice-1' })
const undoAtom = atom({ plugin: 'ide-for-claude', key: 'undo' } as const, null as { path: string; text: string } | null, { shape: 'undo-1' })

const toggledAtom = atom({ plugin: 'ide-for-claude', key: 'toggled' } as const, [] as string[], { shape: 'toggled-1' })
const showTreeAtom = atom({ plugin: 'ide-for-claude', key: 'showTree' } as const, false, { shape: 'showTree-2' })
const fullAtom = atom({ plugin: 'ide-for-claude', key: 'full' } as const, false, { shape: 'full-1' })
const CONTEXT = 3
const webAtom = atom({ plugin: 'ide-for-claude', key: 'web' } as const, null as { port: number; token: string } | null, { shape: 'web-1' })
/** la personne a fermé le panneau : il ne se rouvre plus tout seul avant un /ide-for-claude */
/** l'id de session dont l'historique est en mémoire (relu de son fichier s'il y en avait un) */
const restoredForAtom = atom({ plugin: 'ide-for-claude', key: 'restoredFor' } as const, null as string | null, { shape: 'restoredFor-1' })
const projectAtom = atom({ plugin: 'ide-for-claude', key: 'project' } as const, null as Project | null, { shape: 'project-1' })
const queueAtom = atom({ plugin: 'ide-for-claude', key: 'queue' } as const, [] as Queued[], { shape: 'queue-1' })
const planAtom = atom({ plugin: 'ide-for-claude', key: 'plan' } as const, [] as PlanItem[], { shape: 'plan-1' })
/** Claude travaille sur un prompt : les prompts envoyés depuis la page attendent dans la file */
const busyAtom = atom({ plugin: 'ide-for-claude', key: 'busy' } as const, false, { shape: 'busy-1' })
const statusAtom = atom({ plugin: 'ide-for-claude', key: 'status' } as const, null as Status | null, { shape: 'status-1' })
const paneClosedAtom = atom({ plugin: 'ide-for-claude', key: 'paneClosed' } as const, false, { shape: 'paneClosed-1' })

const historyAtom = atom({ plugin: 'ide-for-claude', key: 'history' } as const, [] as Turn[], { shape: 'history-1' })
const reviewAtom = atom({ plugin: 'ide-for-claude', key: 'review' } as const, [] as ReviewItem[], { shape: 'review-1' })
const acceptedAtom = atom({ plugin: 'ide-for-claude', key: 'accepted' } as const, [] as string[], { shape: 'accepted-1' })

type $ = EngineInterface

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'dist', 'build'])
const MAX_TREE = 400
const COLORS: Record<Kind, string> = {
  kw: 'merged',
  str: 'success',
  com: 'subtle',
  num: 'warning',
  fn: 'suggestion',
  type: 'planMode',
  head: 'claude',
  attr: 'permission',
}

const relTo = (cwd: string, path: string) => (path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path)
const absOf = (cwd: string, path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`)
const cut = (text: string, width: number) =>
  text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text

// ---------- diff ligne à ligne (pour surligner les modifs de Claude) ----------
type DiffLine = { op: ' ' | '+' | '-'; text: string; no?: number }

function diffLines(before: string, after: string): DiffLine[] {
  const A = before === '' ? [] : before.split('\n')
  const B = after === '' ? [] : after.split('\n')
  let p = 0
  while (p < A.length && p < B.length && A[p] === B[p]) p++
  let s = 0
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++
  const a = A.slice(p, A.length - s)
  const b = B.slice(p, B.length - s)
  const mid: DiffLine[] = []
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    a.forEach(text => mid.push({ op: '-', text }))
    b.forEach(text => mid.push({ op: '+', text }))
  } else {
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] =
          a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        mid.push({ op: ' ', text: a[i]! })
        i++
        j++
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) mid.push({ op: '-', text: a[i++]! })
      else mid.push({ op: '+', text: b[j++]! })
    }
    while (i < n) mid.push({ op: '-', text: a[i++]! })
    while (j < m) mid.push({ op: '+', text: b[j++]! })
  }
  const all: DiffLine[] = [
    ...A.slice(0, p).map(text => ({ op: ' ' as const, text })),
    ...mid,
    ...A.slice(A.length - s).map(text => ({ op: ' ' as const, text })),
  ]
  let no = 0
  return all.map(line => (line.op === '-' ? line : { ...line, no: ++no }))
}

// ---------- fichiers ----------
async function readText($: $, path: string): Promise<string> {
  const st = await $.fs.stat(path)
  if (st.size > MAX_BYTES) throw new Error('fichier trop gros (> 1 Mo)')
  const text = await $.fs.read(path)
  if (text.includes('\u0000')) throw new Error('fichier binaire')
  return text
}

async function openFile($: $, path: string) {
  try {
    const text = await readText($, path)
    await update($, fileAtom, () => ({ path, saved: text, draft: text }))
    await update($, modeAtom, () => 'view' as Mode)
    await update($, noticeAtom, () => '')
  } catch (err) {
    await update($, noticeAtom, () => `⚠️ ${String((err as Error)?.message ?? err)}`)
  }
}

let confirmFor: string | null = null

async function save($: $) {
  const file = await read($, fileAtom)
  if (!file) return
  if (file.draft === file.saved) {
    await update($, noticeAtom, () => 'Rien à sauvegarder')
    return
  }
  // garde-fou : une sauvegarde qui supprime plus de la moitié du fichier demande une confirmation
  const shrinks = file.saved.length > 20 && file.draft.length < file.saved.length / 2
  if (shrinks && confirmFor !== file.draft) {
    confirmFor = file.draft
    await update($, noticeAtom, () =>
      `⚠️ Le fichier passerait de ${file.saved.length} à ${file.draft.length} caractères. Appuie encore sur s pour confirmer`,
    )
    return
  }
  confirmFor = null
  const onDisk = await readText($, file.path).catch(() => null)
  if (onDisk !== null && onDisk !== file.saved) {
    await update($, noticeAtom, () => '⚠️ Le fichier a changé sur le disque : r pour recharger avant de sauver')
    return
  }
  await update($, undoAtom, () => ({ path: file.path, text: file.saved }))
  await $.fs.write(file.path, file.draft)
  await update($, fileAtom, f => (f ? { ...f, saved: f.draft } : f))
  // le fichier est maintenant ta version : plus de surlignage Claude dessus
  await update($, changesAtom, list => list.filter(c => c.path !== file.path))
  void pushChanges($).catch(() => undefined)
  await update($, modeAtom, () => 'view' as Mode)
  await update($, noticeAtom, () => '💾 Sauvegardé (z pour annuler)')
}

async function undoSave($: $) {
  const undo = await read($, undoAtom)
  if (!undo) return
  await $.fs.write(undo.path, undo.text)
  await update($, undoAtom, () => null)
  const file = await read($, fileAtom)
  if (file?.path === undo.path) await update($, fileAtom, () => ({ path: undo.path, saved: undo.text, draft: undo.text }))
  await update($, noticeAtom, () => '↶ Sauvegarde annulée')
}

// ---------- suivi des modifs de Claude ----------
type Who = { agent?: string; via?: string }

/** Le nom lisible du sous-agent qui fait l'appel, ou rien pour Claude lui-même. */
async function agentLabel($: $, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  const info = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
  if (!info) return 'sous-agent'
  const who = info.name ?? info.type
  return info.description ? `${who} · ${info.description}` : who
}

/** Une modif constatée : surlignage, historique, panneau et page web. */
async function recordChange($: $, path: string, prior: string | null, after: string, who: Who) {
  const before = prior ?? ''
  if (after === before && prior !== null) return
  // le surlignage montre tout ce que Claude a changé depuis ton dernier prompt
  await update($, changesAtom, list => {
    const old = list.find(c => c.path === path && !c.stale)
    return [...list.filter(c => c.path !== path), old ?? { path, before, stale: false, agent: who.agent }]
  })
  await recordHistory($, path, prior, after, who)
  void pushChanges($).catch(() => undefined)
  const file = await read($, fileAtom)
  const isDirty = file !== null && file.draft !== file.saved
  if (file?.path === path && !isDirty) await update($, fileAtom, () => ({ path, saved: after, draft: after }))
  else if (file?.path === path) await update($, noticeAtom, () => '⚠️ Claude a modifié ce fichier pendant que tu l’éditais')
  else if (!isDirty) await openFile($, path)
  if (!(await read($, webAtom)) && !(await read($, paneClosedAtom)) && (await ideSettings($)).autoOpenPane)
    void $.ui.open({ id: PANE, title: TITLE })
}

async function track<R>($: $, path: string, who: Who, run: () => Promise<R>): Promise<R> {
  const prior = await readText($, path).catch(() => null)
  const result = await run()
  const after = await readText($, path).catch(() => null)
  if (after !== null && after !== (prior ?? '')) await recordChange($, path, prior, after, who)
  return result
}

// ---------- modifs faites par Bash (sed -i, mv, scripts, formateurs...) ----------
// Avant la commande, on photographie ce qui peut changer ; après, on compare.
// Dans un dépôt git : les fichiers déjà modifiés (leur contenu) + git HEAD pour les autres.
// Hors git : un parcours du projet, avec un cache des contenus par date de modification.
const MAX_SNAP_FILES = 2000
const MAX_SNAP_BYTES = 30_000_000

type Snapshot =
  | { kind: 'git'; top: string; dirty: Map<string, string | null> }
  | { kind: 'scan'; files: Map<string, { mtimeMs: number; size: number }>; complete: boolean }

let gitTop: { cwd: string; top: string | null } | null = null
async function gitTopOf($: $, cwd: string): Promise<string | null> {
  if (gitTop?.cwd === cwd) return gitTop.top
  const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => null)
  const top = r && r.exitCode === 0 ? r.stdout.trim() || null : null
  gitTop = { cwd, top }
  return top
}

/** Les fichiers que git voit modifiés, ajoutés ou non suivis (chemins absolus). */
async function gitDirty($: $, top: string): Promise<string[] | null> {
  const r = await $.process
    .run(['git', '-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 15_000 })
    .catch(() => null)
  if (!r || r.exitCode !== 0) return null
  const out: string[] = []
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const x = entry[0]
    out.push(`${top}/${entry.slice(3)}`)
    // un renommage donne aussi l'ancien chemin dans l'entrée suivante
    if (x === 'R' || x === 'C') out.push(`${top}/${parts[++i] ?? ''}`)
  }
  return out
}

async function gitHead($: $, top: string, path: string): Promise<string | null> {
  const r = await $.process
    .run(['git', '-C', top, 'show', `HEAD:${path.slice(top.length + 1)}`], { timeoutMs: 15_000 })
    .catch(() => null)
  if (!r || r.exitCode !== 0 || r.isStdoutTruncated || r.stdout.includes('\u0000')) return null
  return r.stdout
}

/** Contenus connus hors git, par chemin : relus seulement quand la date ou la taille change. */
const scanCache = new Map<string, { mtimeMs: number; size: number; text: string | null }>()

async function scanProject($: $, cwd: string) {
  const files = new Map<string, { mtimeMs: number; size: number }>()
  let complete = true
  const walk = async (dir: string): Promise<void> => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const x of entries) {
      if (HIDDEN.has(x.name) || x.isLink) continue
      const path = `${dir}/${x.name}`
      if (x.kind === 'dir') await walk(path)
      else if (x.kind === 'file') {
        if (files.size >= MAX_SNAP_FILES) {
          complete = false
          return
        }
        files.set(path, { mtimeMs: x.mtimeMs, size: x.size })
      }
    }
  }
  await walk(cwd)
  return { files, complete }
}

async function cachedText($: $, path: string, st: { mtimeMs: number; size: number }) {
  const hit = scanCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
  const text = st.size > MAX_BYTES ? null : await readText($, path).catch(() => null)
  scanCache.set(path, { ...st, text })
  return text
}

async function snapshot($: $): Promise<Snapshot | null> {
  const cwd = await $.session.cwd()
  const top = await gitTopOf($, cwd)
  if (top) {
    const paths = await gitDirty($, top)
    if (!paths) return null
    const dirty = new Map<string, string | null>()
    for (const p of paths.slice(0, MAX_SNAP_FILES)) {
      const st = await $.fs.stat(p).catch(() => null)
      dirty.set(p, st && st.kind === 'file' ? await cachedText($, p, st) : null)
    }
    return { kind: 'git', top, dirty }
  }
  const { files, complete } = await scanProject($, cwd)
  // on remplit le cache tant que le budget le permet : c'est l'état « avant »
  let bytes = 0
  for (const [p, st] of files) {
    if ((bytes += st.size) > MAX_SNAP_BYTES) break
    await cachedText($, p, st)
  }
  return { kind: 'scan', files, complete }
}

/** Compare avec la photo d'avant et enregistre ce que la commande a changé. */
async function diffSnapshot($: $, snap: Snapshot, who: Who) {
  const found: { path: string; prior: string | null; after: string | null }[] = []
  const unknown: string[] = []
  if (snap.kind === 'git') {
    const now = (await gitDirty($, snap.top)) ?? []
    for (const p of new Set([...snap.dirty.keys(), ...now])) {
      const prior = snap.dirty.has(p) ? snap.dirty.get(p)! : await gitHead($, snap.top, p)
      const after = await readText($, p).catch(() => null)
      if (after !== prior) found.push({ path: p, prior, after })
    }
  } else {
    const cwd = await $.session.cwd()
    const { files } = await scanProject($, cwd)
    for (const [p, st] of files) {
      const old = snap.files.get(p)
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue
      const known = scanCache.get(p)
      const prior = old ? (known && known.mtimeMs === old.mtimeMs && known.size === old.size ? known.text : undefined) : null
      const after = await cachedText($, p, st)
      // modifié, mais on n'avait pas son contenu d'avant (projet trop gros) : pas de diff possible
      if (prior === undefined) unknown.push(p)
      else if (after !== prior) found.push({ path: p, prior, after })
    }
    for (const p of snap.files.keys()) if (!files.has(p)) found.push({ path: p, prior: scanCache.get(p)?.text ?? null, after: null })
  }
  const gone: string[] = []
  for (const f of found) {
    if (f.after === null) {
      if (f.prior !== null) gone.push(f.path)
      continue
    }
    await recordChange($, f.path, f.prior, f.after, who)
  }
  const cwd = await $.session.cwd()
  if (unknown.length) {
    const list = unknown.map(p => relTo(cwd, p)).join(', ')
    await update($, noticeAtom, () => `⚠️ Modifié par Bash, sans diff (projet trop gros) : ${cut(list, 200)}`)
  }
  if (gone.length) {
    for (const p of gone) await closeReview($, p)
    void pushChanges($).catch(() => undefined)
    const list = gone.map(p => relTo(cwd, p)).join(', ')
    await update($, noticeAtom, () => `🗑️ Supprimé par Bash : ${cut(list, 200)}`)
    void notify($, { type: 'toast', text: `🗑️ Claude a supprimé ${gone.length > 1 ? `${gone.length} fichiers` : list} avec Bash` })
  }
}

// ---------- historique prompt par prompt ----------
const MAX_TURNS = 100
const MAX_HIST_BYTES = 1_000_000

async function newTurn($: $, prompt: string) {
  await update($, historyAtom, list => {
    // un prompt sans modif de fichier ne garde pas sa place dans l'historique
    const kept = list.filter(t => t.files.length > 0)
    const id = (list[list.length - 1]?.id ?? 0) + 1
    return [...kept, { id, prompt: prompt.slice(0, 300), at: Date.now(), files: [] }].slice(-MAX_TURNS)
  })
}

async function recordHistory($: $, path: string, prior: string | null, after: string, who: Who) {
  if ((prior?.length ?? 0) + after.length > MAX_HIST_BYTES) return
  await update($, historyAtom, list => {
    const turns = list.length ? list : [{ id: 1, prompt: '(avant le premier prompt)', at: Date.now(), files: [] }]
    const last = turns[turns.length - 1]!
    const old = last.files.find(f => f.path === path)
    const files: HistFile[] = old
      ? last.files.map(f => (f.path === path ? { ...f, after, agent: f.agent ?? who.agent, via: f.via ?? who.via } : f))
      : [...last.files, { path, before: prior, after, ...(who.agent ? { agent: who.agent } : {}), ...(who.via ? { via: who.via } : {}) }]
    return [...turns.slice(0, -1), { ...last, files }]
  })
}

/** Remet les fichiers dans l'état d'avant le prompt `turnId` (et tous ceux d'après). */
async function restoreTo($: $, turnId: number, force: boolean) {
  const turns = (await read($, historyAtom)).filter(t => t.id >= turnId && t.files.length > 0)
  if (!turns.length) return notify($, { type: 'toast', text: 'Rien à restaurer.' })
  const plan = new Map<string, { before: string | null; after: string }>()
  for (const t of turns)
    for (const f of t.files) {
      const old = plan.get(f.path)
      plan.set(f.path, { before: old ? old.before : f.before, after: f.after })
    }
  const touched: string[] = []
  for (const [path, p] of plan) {
    const now = await readText($, path).catch(() => null)
    if (now !== p.after) touched.push(path)
  }
  if (touched.length && !force)
    return notify($, { type: 'restoreConflict', turnId, files: touched })
  const cwd = await $.session.cwd()
  for (const [path, p] of plan) {
    if (p.before === null) await $.process.run(['rm', '-f', '--', path]).catch(() => undefined)
    else await $.fs.write(path, p.before)
  }
  const paths = [...plan.keys()]
  await update($, changesAtom, list => list.filter(c => !plan.has(c.path)))
  const first = turns[0]!
  await addReview($, {
    kind: 'restore',
    text: `L'utilisateur a annulé tes modifications depuis le prompt ${first.id} (« ${first.prompt.slice(0, 80)} ») : ${paths.map(p => relTo(cwd, p)).join(', ')} ont été remis dans leur état d'avant.`,
  })
  const file = await read($, fileAtom)
  if (file && plan.has(file.path)) await openFile($, file.path)
  await notify($, { type: 'toast', text: `↶ ${paths.length} fichier${paths.length > 1 ? 's' : ''} restauré${paths.length > 1 ? 's' : ''}` })
}

// ---------- review : commentaires, rejets ----------
const newId = () => {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

async function addReview($: $, item: Omit<ReviewItem, 'id' | 'at'> & { id?: string }) {
  await update($, reviewAtom, list => [...list, { ...item, id: item.id ?? newId(), at: Date.now() }])
  void pushChanges($).catch(() => undefined)
}

const fence = (code: string) => {
  const ticks = code.includes('```') ? '````' : '```'
  return `${ticks}\n${code.replace(/\n$/, '')}\n${ticks}`
}

async function reviewBlock($: $): Promise<string | null> {
  const items = await read($, reviewAtom)
  if (!items.length) return null
  const cwd = await $.session.cwd()
  const lines = items.map((it, i) => {
    const where = it.path ? `${relTo(cwd, it.path)}${it.line ? ` ligne${it.endLine && it.endLine !== it.line ? `s ${it.line}-${it.endLine}` : ` ${it.line}`}` : ''}` : ''
    if (it.kind === 'reject')
      return `${i + 1}. ${where} : BLOC REJETÉ. L'utilisateur a remis le code d'avant.${it.code ? `\n   Ton code rejeté :\n${fence(it.code)}` : ''}${it.text ? `\n   Commentaire : ${it.text}` : ''}`
    if (it.kind === 'restore') return `${i + 1}. ${it.text}`
    if (it.kind === 'idea') return `${i + 1}. ${it.text}`
    if (it.kind === 'tests') return `${i + 1}. ${it.text}${it.code ? `\n${fence(it.code)}` : ''}`
    if (it.kind === 'snippet')
      return `${i + 1}. ${where} : extrait de code partagé par l'utilisateur :\n${fence(it.code ?? '')}${it.text ? `\n   Note : ${it.text}` : ''}`
    return `${i + 1}. ${where}${it.code ? `, sur :\n${fence(it.code)}` : ''}\n   Commentaire : ${it.text}`
  })
  return [
    'Éléments joints par l’utilisateur depuis IDE for Claude (review de tes modifications et extraits de code). Prends en compte chaque point :',
    '',
    ...lines,
  ].join('\n')
}

// ---------- persistance : l'historique d'une session survit au redémarrage ----------
// $.state ne vit que le temps du processus, et $.store est limité à 4 Mo pour toute la mod :
// chaque session a donc son fichier, ~/.claude/plugins/data/ide-for-claude/sessions/<id>.json.
// `claude --resume` retrouve le même id (le nom de la transcription) et donc le même historique.
const KEEP_DAYS = 30
type Saved = {
  v: 1
  cwd: string
  savedAt: number
  history: Turn[]
  changes: Change[]
  review: ReviewItem[]
  accepted: string[]
  queue?: Queued[]
  plan?: PlanItem[]
}

let base: string | null = null
/** ~/.claude/plugins/data/ide-for-claude (ou sous CLAUDE_CONFIG_DIR) */
async function baseDir($: $) {
  if (base) return base
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
  base = `${config}/plugins/data/ide-for-claude`
  return base
}
const dataDir = async ($: $) => `${await baseDir($)}/sessions`

async function sessionFileOf($: $, id: string) {
  return id && /^[\w.-]+$/.test(id) ? `${await dataDir($)}/${id}.json` : null
}

async function readSaved($: $, file: string): Promise<Partial<Saved> | null> {
  const text = await $.fs.read(file).catch(() => null)
  if (typeof text !== 'string') return null
  try {
    const data = JSON.parse(text) as Partial<Saved>
    return data.v === 1 && Array.isArray(data.history) ? data : null
  } catch {
    return null
  }
}

/**
 * Rattache l'état en mémoire à la session en cours. Une reprise (`/resume`, la liste de
 * `claude --resume`) ou un `/clear` change l'id de session SANS relancer session.start :
 * on vérifie donc l'id à chaque fois, et on relit son fichier avant toute écriture.
 * Ce qui est déjà en mémoire (modifs faites depuis la bascule) passe après l'historique relu.
 */
async function ensureRestored($: $): Promise<string | null> {
  const id = await $.session.id().catch(() => '')
  if (!id) return null
  if ((await read($, restoredForAtom)) === id) return id
  const file = await sessionFileOf($, id)
  const data = file ? await readSaved($, file) : null
  if (data) {
    const saved = data.history!
    let next = saved.reduce((m, t) => Math.max(m, t.id), 0)
    await update($, historyAtom, mine => [...saved, ...mine.map(t => ({ ...t, id: ++next }))])
    const savedChanges = (data.changes ?? []).map(c => ({ ...c, stale: true }))
    await update($, changesAtom, mine => [...savedChanges.filter(c => !mine.some(m => m.path === c.path)), ...mine])
    await update($, reviewAtom, mine => [...(data.review ?? []).filter(r => !mine.some(m => m.id === r.id)), ...mine])
    await update($, acceptedAtom, mine => [...new Set([...(data.accepted ?? []), ...mine])])
    if (Array.isArray(data.queue)) await update($, queueAtom, mine => [...data.queue!.filter(q => !mine.some(m => m.id === q.id)), ...mine])
    if (Array.isArray(data.plan)) await update($, planAtom, mine => (mine.length ? mine : data.plan!))
  }
  await update($, restoredForAtom, () => id)
  return id
}

/** Écrit l'état de revue de la session sur le disque. Ne rejette jamais. */
async function persist($: $, id?: string) {
  try {
    // jamais d'écriture avant d'avoir relu ce que le fichier contient déjà
    const sid = id ?? (await ensureRestored($))
    const file = sid ? await sessionFileOf($, sid) : null
    if (!file) return
    const history = (await read($, historyAtom)).filter(t => t.files.length > 0)
    const changes = await read($, changesAtom)
    const review = await read($, reviewAtom)
    // une session sans aucune modif ne laisse pas de fichier ; une revue vidée met le sien à jour
    const queued = (await read($, queueAtom)).length
    if (!history.length && !changes.length && !review.length && !queued && !(await $.fs.exists(file))) return
    const data: Saved = {
      v: 1,
      cwd: await $.session.cwd(),
      savedAt: Date.now(),
      history,
      changes,
      review,
      accepted: await read($, acceptedAtom),
      queue: await read($, queueAtom),
      plan: await read($, planAtom),
    }
    await $.fs.write(file, JSON.stringify(data))
  } catch {
    // disque plein, dossier refusé... l'historique reste en mémoire pour la session
  }
}

/** La conversation se termine (sortie, /clear, reprise d'une autre) : on l'enregistre, puis on repart à vide. */
async function endSession($: $, sessionId: string, reason: string) {
  if ((await read($, restoredForAtom)) === sessionId) await persist($, sessionId)
  if (reason !== 'clear' && reason !== 'resume') return
  await update($, historyAtom, () => [])
  await update($, changesAtom, () => [])
  await update($, reviewAtom, () => [])
  await update($, acceptedAtom, () => [])
  await update($, queueAtom, () => [])
  await update($, planAtom, () => [])
  await update($, busyAtom, () => false)
  await update($, restoredForAtom, () => null)
  void pushChanges($).catch(() => undefined)
}

/** Les historiques de plus de 30 jours sont effacés. */
async function pruneSessions($: $) {
  const dir = await dataDir($)
  const old = Date.now() - ((await ideSettings($)).historyDays || KEEP_DAYS) * 24 * 3600_000
  for (const x of await $.fs.list(dir).catch(() => [])) {
    if (x.kind === 'file' && x.name.endsWith('.json') && x.mtimeMs < old)
      await $.process.run(['rm', '-f', '--', `${dir}/${x.name}`]).catch(() => undefined)
  }
}

// ---------- par projet : idées, annotations, commandes, prompts envoyés ----------
// Un fichier par projet, ~/.claude/plugins/data/ide-for-claude/projects/<dossier>-<empreinte>.json
const MAX_PROMPTS = 100
const djb2 = (text: string) => {
  let x = 5381
  for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0
  return (x >>> 0).toString(36)
}
const emptyProject = (cwd: string): Project => ({ cwd, ideas: [], annotations: [], commands: [], prompts: [], nextIdea: 1 })
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

async function projectFile($: $, cwd: string) {
  const name = (cwd.split(/[\\/]/).filter(Boolean).pop() || 'racine').replace(/[^\w.-]/g, '_')
  return `${await baseDir($)}/projects/${name}-${djb2(cwd)}.json`
}

/** Le projet de la session, relu de son fichier au premier usage (ou quand le dossier change). */
async function getProject($: $): Promise<Project> {
  const cwd = await $.session.cwd()
  const cur = await read($, projectAtom)
  if (cur && cur.cwd === cwd) return cur
  let p = emptyProject(cwd)
  const text = await $.fs.read(await projectFile($, cwd)).catch(() => null)
  if (typeof text === 'string') {
    try {
      const d = JSON.parse(text) as Partial<Project> & { v?: number }
      if (d.v === 1)
        p = {
          cwd,
          ideas: arr<Idea>(d.ideas),
          annotations: arr<Annotation>(d.annotations),
          commands: arr<SavedCommand>(d.commands),
          prompts: arr<string>(d.prompts),
          nextIdea: Number(d.nextIdea) || 1,
        }
    } catch {
      // fichier abîmé : on repart d'un projet vide, l'ancien reste sur le disque jusqu'à la prochaine écriture
    }
  }
  await update($, projectAtom, () => p)
  return p
}

/** Modifie le projet (sans perdre une modif concurrente), l'écrit et prévient la page. */
async function changeProject($: $, fn: (p: Project) => Project): Promise<Project> {
  const loaded = await getProject($)
  await update($, projectAtom, p => fn(p && p.cwd === loaded.cwd ? p : loaded))
  const p = (await read($, projectAtom))!
  await $.fs.write(await projectFile($, p.cwd), JSON.stringify({ v: 1, ...p })).catch(() => undefined)
  void pushChanges($).catch(() => undefined)
  return p
}

async function addIdea($: $, idea: Omit<Idea, 'id' | 'n' | 'at' | 'status'>): Promise<Idea> {
  let made: Idea | null = null
  await changeProject($, p => {
    made = { ...idea, id: newId(), n: p.nextIdea, at: Date.now(), status: 'new' }
    return { ...p, ideas: [...p.ideas, made], nextIdea: p.nextIdea + 1 }
  })
  return made!
}

const ideaText = (cwd: string, i: Idea) => {
  const where = i.path ? ` (${relTo(cwd, i.path)}${i.line ? `:${i.line}${i.endLine && i.endLine !== i.line ? `-${i.endLine}` : ''}` : ''})` : ''
  return `Idée #i${i.n} de la boîte à idées${where} : ${i.text}${i.tags.length ? ` [${i.tags.join(', ')}]` : ''}${i.code ? `\n${fence(i.code)}` : ''}`
}

// ---------- réglages ----------
type IdeSettings = {
  /** le panneau du terminal s'ouvre tout seul à la première modif de Claude */
  autoOpenPane: boolean
  /** la revue en attente part avec le prochain prompt */
  attachReview: boolean
  /** jours de conservation de l'historique des sessions */
  historyDays: number
  /** modèle de la barre d'état de la page */
  statusline: string
  /** `claude` : la statusLine configurée dans Claude Code (son script) ; `template` : le modèle ci-dessus */
  statuslineSource: 'claude' | 'template'
}
const IDE_DEFAULTS: IdeSettings = {
  autoOpenPane: true,
  attachReview: true,
  historyDays: 30,
  statusline: '{model} · contexte {context} · {cost} · {branch}',
  statuslineSource: 'claude',
}
async function ideSettings($: $): Promise<IdeSettings> {
  const s = (await $.store.get('ide').catch(() => undefined)) as Partial<IdeSettings> | undefined
  return { ...IDE_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) }
}
async function setIdeSettings($: $, patch: Partial<IdeSettings>) {
  const next = { ...(await ideSettings($)), ...patch }
  if (typeof next.historyDays !== 'number' || next.historyDays < 1) next.historyDays = IDE_DEFAULTS.historyDays
  await $.store.set('ide', next)
  void pushChanges($).catch(() => undefined)
}
/** réglages de l'éditeur, à la manière du settings.json de VS Code (`editor.fontSize`...) */
const editorSettings = async ($: $) => ((await $.store.get('editor').catch(() => undefined)) as Record<string, unknown> | undefined) ?? {}

/** settings.json de VS Code : JSON avec commentaires et virgules finales */
function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

async function importVSCode($: $): Promise<string> {
  const home = (await $.env.get('HOME')) || ''
  const appdata = (await $.env.get('APPDATA')) || ''
  const candidates = [
    `${home}/Library/Application Support/Code/User/settings.json`,
    `${home}/.config/Code/User/settings.json`,
    appdata ? `${appdata}/Code/User/settings.json` : '',
    `${home}/Library/Application Support/Cursor/User/settings.json`,
    `${home}/.config/Cursor/User/settings.json`,
  ].filter(Boolean)
  for (const file of candidates) {
    const text = await $.fs.read(file).catch(() => null)
    if (typeof text !== 'string') continue
    let parsed: unknown
    try {
      parsed = parseJsonc(text)
    } catch {
      return `⚠️ ${file} n'est pas un JSON lisible`
    }
    const picked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (k.startsWith('editor.') || k === 'workbench.colorTheme' || k === 'files.trimTrailingWhitespace') picked[k] = v
    await $.store.set('editor', { ...(await editorSettings($)), ...picked })
    void pushChanges($).catch(() => undefined)
    return `✅ ${Object.keys(picked).length} réglages importés de ${file.replace(home, '~')}`
  }
  return '⚠️ Aucun settings.json de VS Code trouvé'
}

/** les settings.json de Claude Code, par portée */
async function settingsFiles($: $) {
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''}/.claude`
  const cwd = await $.session.cwd()
  return {
    user: `${config}/settings.json`,
    project: `${cwd}/.claude/settings.json`,
    local: `${cwd}/.claude/settings.local.json`,
  } as Record<string, string>
}

async function sendConfig($: $) {
  const rows = await $.config.list().catch(() => [])
  const files: Record<string, { path: string; text: string | null }> = {}
  for (const [scope, path] of Object.entries(await settingsFiles($))) {
    const text = await $.fs.read(path).catch(() => null)
    files[scope] = { path, text: typeof text === 'string' ? text : null }
  }
  await notify($, { type: 'config', rows, files })
}

// ---------- barre d'état : modèle, contexte, coût, branche ----------
let statusAt = 0
async function refreshStatus($: $, force = false) {
  if (!force && Date.now() - statusAt < 1500) return
  statusAt = Date.now()
  try {
    const usage = await $.session.usage().catch(() => null)
    const model = await $.session.model().catch(() => undefined)
    const cwd = await $.session.cwd()
    const head = await $.process.run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 }).catch(() => null)
    const status: Status & { branch?: string; line?: string } = {
      model,
      tokens: usage?.context.tokens,
      window: usage?.context.window,
      percent: usage?.context.percent,
      usd: usage?.cost?.usd,
      at: Date.now(),
      ...(head && head.exitCode === 0 ? { branch: head.stdout.trim() } : {}),
    }
    if ((await ideSettings($)).statuslineSource !== 'template') {
      const line = await claudeStatusLine($, cwd, model, usage).catch(() => null)
      if (line) status.line = line
    }
    await update($, statusAtom, () => status)
    await notify($, { type: 'status', status })
  } catch {
    // la barre d'état n'est qu'un confort
  }
}

/** « claude-opus-5-5[1m] » -> « Opus 5.5 », comme Claude Code l'affiche */
function modelName(id: string | undefined) {
  if (!id) return undefined
  const m = id.replace(/\[.*\]$/, '').match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

/**
 * La barre d'état configurée dans Claude Code (settings « statusLine » de type command) :
 * on lance la même commande avec le JSON que Claude Code lui donne, et on garde sa sortie,
 * couleurs du terminal comprises (la page les convertit).
 */
async function claudeStatusLine($: $, cwd: string, model: string | undefined, usage: Awaited<ReturnType<$['session']['usage']>> | null) {
  const conf = (await $.settings.read({ key: 'statusLine' }).catch(() => undefined)) as { type?: string; command?: string } | undefined
  if (!conf || conf.type !== 'command' || !conf.command) return null
  const limit = (kind: string) => {
    const r = usage?.rateLimits.find(x => x.kind === kind)
    return r ? { used_percentage: r.percentUsed, ...(r.resetsAt ? { resets_at: r.resetsAt } : {}) } : undefined
  }
  const effort = (await $.env.get('CLAUDE_EFFORT').catch(() => undefined)) || ((await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)) as string | undefined)
  const input = {
    hook_event_name: 'Status',
    session_id: await $.session.id().catch(() => ''),
    cwd,
    model: { id: model, display_name: modelName(model) },
    workspace: { current_dir: cwd, project_dir: await $.session.root().catch(() => cwd) },
    version: (await $.session.version().catch(() => null))?.version,
    ...(typeof usage?.cost?.usd === 'number' ? { cost: { total_cost_usd: usage.cost.usd } } : {}),
    ...(usage
      ? {
          context_window: {
            context_window_size: usage.context.window,
            ...(typeof usage.context.percent === 'number' ? { used_percentage: usage.context.percent } : {}),
            ...(typeof usage.context.tokens === 'number' ? { total_input_tokens: usage.context.tokens } : {}),
          },
        }
      : {}),
    rate_limits: { five_hour: limit('five_hour'), seven_day: limit('seven_day') },
    ...(effort ? { effort: { level: effort } } : {}),
  }
  const r = await $.process.run(['sh', '-c', conf.command], { cwd, stdin: JSON.stringify(input), timeoutMs: 5000 })
  const out = r.stdout.replace(/\s+$/, '')
  return r.exitCode === 0 && out ? out.split('\n').slice(0, 3).join('\n') : null
}

// ---------- commandes de Claude Code (/ et skills), pour l'autocomplétion ----------
let commandsCache: { at: number; list: { name: string; description: string; source: string }[] } | null = null
async function slashCommands($: $) {
  if (commandsCache && Date.now() - commandsCache.at < 60_000) return commandsCache.list
  const list = (await $.command.list().catch(() => [])).map(c => ({ name: c.name, description: c.description, source: c.source }))
  commandsCache = { at: Date.now(), list }
  return list
}

// ---------- envoyer un prompt depuis la page : mentions, file d'attente ----------
const MAX_INLINE = 30_000

/** @fichier, @fichier:12-30, #i3 et /skill deviennent du contexte joint au prompt. */
async function expandMentions($: $, raw: string) {
  const cwd = await $.session.cwd()
  const context: string[] = []
  const usedIdeas: string[] = []
  const seen = new Set<string>()
  for (const m of raw.matchAll(/(^|\s)@([^\s:]+)(?::(\d+)(?:-(\d+))?)?/g)) {
    const path = absOf(cwd, m[2]!)
    const key = m[0].trim()
    if (seen.has(key)) continue
    seen.add(key)
    const text = await readText($, path).catch(() => null)
    if (text === null) continue
    const rel = relTo(cwd, path)
    if (m[3]) {
      const a = Number(m[3])
      const b = Math.max(a, Number(m[4] ?? m[3]))
      const lines = text.split('\n').slice(a - 1, b).join('\n')
      context.push(`${rel}, ligne${b > a ? `s ${a}-${b}` : ` ${a}`} (mentionné par l'utilisateur) :\n${fence(lines)}`)
    } else if (text.length <= MAX_INLINE) context.push(`Contenu de ${rel} (mentionné par l'utilisateur) :\n${fence(text)}`)
    else context.push(`Fichier mentionné par l'utilisateur : ${rel} (trop gros pour être joint, lis-le si besoin)`)
  }
  const project = await getProject($)
  for (const m of raw.matchAll(/(^|\s)#i(\d+)\b/g)) {
    const idea = project.ideas.find(i => i.n === Number(m[2]))
    if (!idea || usedIdeas.includes(idea.id)) continue
    usedIdeas.push(idea.id)
    context.push(ideaText(cwd, idea))
  }
  const commands = await slashCommands($)
  for (const m of raw.matchAll(/(^|\s)\/([\w:.-]+)/g)) {
    if (m.index === 0 && raw.trimStart().startsWith('/')) continue
    const c = commands.find(x => x.name === m[2])
    if (c) context.push(`L'utilisateur mentionne /${c.name} (${c.description}). Sers-t'en si c'est pertinent.`)
  }
  return { context, usedIdeas }
}

async function submitPrompt($: $, raw: string) {
  const text = raw.trim()
  if (!text) return
  await changeProject($, p => ({ ...p, prompts: [...p.prompts.filter(x => x !== text), text].slice(-MAX_PROMPTS) }))
  // « /commande arguments » en tête : c'est une commande, comme tapée dans le terminal
  const lead = text.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/)
  if (lead && (await slashCommands($)).some(c => c.name === lead[1])) {
    void $.command.run({ command: lead[1]!, args: lead[2] ?? '' }).catch(() => undefined)
    return
  }
  const { context, usedIdeas } = await expandMentions($, text)
  if (usedIdeas.length)
    await changeProject($, p => ({ ...p, ideas: p.ideas.map(i => (usedIdeas.includes(i.id) && i.status === 'new' ? { ...i, status: 'doing' } : i)) }))
  // Claude Code ne passe pas un prompt envoyé par la mod dans ses propres hooks prompt.submit :
  // on fait ici ce que ce hook fait pour un prompt tapé (nouveau tour, revue jointe)...
  await ensureRestored($).catch(() => null)
  await update($, changesAtom, list => list.map(c => ({ ...c, stale: true })))
  await newTurn($, text)
  await update($, busyAtom, () => true)
  const block = (await ideSettings($)).attachReview ? await reviewBlock($) : null
  if (block) {
    await update($, reviewAtom, () => [])
    context.push(block)
  }
  void pushChanges($).catch(() => undefined)
  void persist($)
  // ... et comme $.prompt.submit ne prend pas de contexte à part, il suit le texte
  const full = context.length ? `${text}\n\n---\nJoint depuis IDE for Claude :\n\n${context.join('\n\n')}` : text
  void $.prompt.submit({ text: full, asUser: true }).catch(() => undefined)
}

/** Claude a fini : le prompt suivant de la file part. */
async function drainQueue($: $) {
  const queue = await read($, queueAtom)
  if (!queue.length || (await read($, busyAtom))) return
  const [first, ...rest] = queue
  await update($, queueAtom, () => rest)
  await submitPrompt($, first!.text)
  void pushChanges($).catch(() => undefined)
}

// ---------- outils que Claude peut appeler ----------
const TOOL_PREFIX = 'mcp__ide-for-claude__'
const toolText = (text: string, isError = false) => ({ result: { content: [{ type: 'text', text }], isError } })
const TOOLS = [
  {
    name: 'idea_add',
    description:
      "Note une idée dans la boîte à idées d'IDE for Claude (l'IDE web de l'utilisateur), gardée par projet. À utiliser quand l'utilisateur te demande de noter une idée, ou quand tu remarques une amélioration, un bug ou une piste à traiter plus tard, plutôt que de la laisser se perdre dans la conversation. Tu peux la rattacher à un fichier et des lignes.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "L'idée, en une ou deux phrases" },
        tags: { type: 'array', items: { type: 'string' }, description: 'Étiquettes courtes (facultatif)' },
        file: { type: 'string', description: 'Fichier concerné, chemin relatif au projet (facultatif)' },
        line: { type: 'integer', description: 'Première ligne concernée (facultatif)' },
        endLine: { type: 'integer', description: 'Dernière ligne concernée (facultatif)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'annotate',
    description:
      "Pose une annotation dans le code, visible par l'utilisateur dans IDE for Claude : une liste où un clic ouvre le fichier sur la ligne. À utiliser quand l'utilisateur demande où se trouve quelque chose (« où est géré X ? »), pour lui montrer des endroits précis du code, ou pour baliser ce qu'il doit relire. Une annotation par endroit, avec une note courte qui dit ce qu'on y trouve.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Chemin du fichier, relatif au projet' },
        line: { type: 'integer', description: 'Ligne (à partir de 1)' },
        endLine: { type: 'integer', description: 'Dernière ligne si plusieurs (facultatif)' },
        note: { type: 'string', description: 'Ce qu’on trouve à cet endroit, en une phrase' },
      },
      required: ['file', 'line', 'note'],
    },
  },
  {
    name: 'annotations_clear',
    description: "Retire les annotations posées dans IDE for Claude : toutes, ou seulement celles d'un fichier.",
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Seulement ce fichier (facultatif)' } } },
  },
  {
    name: 'command_save',
    description:
      "Enregistre une commande dans l'exécuteur de commandes d'IDE for Claude, pour que l'utilisateur la lance d'un clic depuis la page (lancer le projet, un serveur de dev, les tests, un build...). Ne lance pas la commande. Un nom déjà pris est remplacé.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom court et parlant, par exemple « Serveur de dev »' },
        command: { type: 'string', description: 'La commande shell, lancée à la racine du projet' },
        description: { type: 'string', description: 'À quoi elle sert (facultatif)' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'statusline_set',
    description:
      "Change le modèle de la barre d'état de la page IDE for Claude, quand l'utilisateur le demande. Variables : {model} {context} (pourcentage) {tokens} {window} {cost} {branch} {plan} (étape en cours) {queue} (prompts en attente) {review} (fichiers en revue) {time}.",
    inputSchema: { type: 'object', properties: { template: { type: 'string' } }, required: ['template'] },
  },
] as const

// ---------- préférences du panneau terminal, pour toutes les sessions ----------
const PANE_PREFS = 'pane'
async function loadPanePrefs($: $) {
  const p = (await $.store.get(PANE_PREFS).catch(() => undefined)) as { full?: boolean; showTree?: boolean } | undefined
  if (typeof p?.full === 'boolean') await update($, fullAtom, () => p.full!)
  if (typeof p?.showTree === 'boolean') await update($, showTreeAtom, () => p.showTree!)
}
async function savePanePrefs($: $) {
  await $.store.set(PANE_PREFS, { full: await read($, fullAtom), showTree: await read($, showTreeAtom) }).catch(() => undefined)
}

// ---------- préférences du navigateur, par projet ----------
const prefsKey = (cwd: string) => `prefs:${cwd}`

// ---------- serveur web (un par session, donc un par projet ouvert) ----------
// `server` est le serveur que CETTE copie de la mod a lancé et dont elle lit la sortie.
// Claude Code peut remplacer la copie en cours de session : la variable repart à null
// alors que `webAtom` (l'état de la session) dit qu'une page est ouverte. Dans ce cas
// le premier envoi relance le serveur sur le même port, avec la même clé : la page se reconnecte.
let server: Promise<string> | null = null
/** vrai dès que le serveur de cette copie écoute ; avant, il recevra tout l'état d'un coup */
let ready = false
/** dernier échec de démarrage : on ne relance pas le serveur à chaque appel d'outil s'il ne démarre pas */
let failedAt = 0

const randomToken = () => {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function post($: $, route: string, payload: unknown) {
  const web = await read($, webAtom)
  if (!web) return
  if (!server) {
    // la copie a changé : on reprend la main ; une fois prêt, le serveur reçoit tout l'état
    if (Date.now() - failedAt > 30_000) void startWeb($).catch(() => undefined)
    return
  }
  if (!ready) return
  await $.http
    .fetch(`http://127.0.0.1:${web.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': web.token },
      body: JSON.stringify(payload),
    })
    .catch(() => undefined)
}

/** Envoie au serveur tout l'état de la session : la page se met à jour en direct. */
async function pushChanges($: $) {
  if (!(await read($, webAtom))) return
  const cwd = await $.session.cwd()
  await post($, '/api/push', {
    changes: (await read($, changesAtom)).map(c => ({ path: c.path, before: c.before, agent: c.agent })),
    history: await read($, historyAtom),
    review: await read($, reviewAtom),
    accepted: await read($, acceptedAtom),
    prefs: (await $.store.get(prefsKey(cwd))) ?? null,
    project: await getProject($).catch(() => null),
    queue: await read($, queueAtom),
    plan: await read($, planAtom),
    busy: await read($, busyAtom),
    status: await read($, statusAtom),
    ide: await ideSettings($),
    editor: await editorSettings($),
    commands: await slashCommands($),
  })
}

/** Un message pour la page seulement (activité, notification, toast). Ne rejette jamais. */
const notify = ($: $, payload: Record<string, unknown>) => post($, '/api/notify', payload).catch(() => undefined)

type WebEvent = {
  type?: string
  path?: string
  line?: number
  endLine?: number
  code?: string
  text?: string
  id?: string
  keys?: string[]
  paths?: unknown[]
  on?: boolean
  turnId?: number
  force?: boolean
  file?: boolean
  prefs?: unknown
  startLine?: number
  tags?: unknown
  status?: string
  name?: string
  command?: string
  description?: string
  settings?: unknown
  key?: string
  value?: unknown
  scope?: string
}

async function onWebEvent($: $, ev: WebEvent) {
  const cwd = await $.session.cwd()
  switch (ev.type) {
    case 'saved':
      if (ev.path) await onWebSave($, ev.path)
      break
    case 'rejected':
      if (!ev.path) break
      if (ev.file) await update($, changesAtom, list => list.filter(c => c.path !== ev.path))
      await addReview($, {
        kind: 'reject',
        path: ev.path,
        line: ev.file ? undefined : ev.line,
        endLine: ev.file ? undefined : ev.endLine,
        code: ev.code,
        text: ev.file ? 'Tout le fichier a été remis dans son état d’avant.' : (ev.text ?? ''),
      })
      await onWebSave($, ev.path, false)
      break
    case 'comment':
      if (ev.path && ev.text)
        await addReview($, { kind: 'comment', path: ev.path, line: ev.line, endLine: ev.endLine, code: ev.code, text: ev.text, id: ev.id })
      break
    case 'uncomment':
      await update($, reviewAtom, list => list.filter(it => it.id !== ev.id))
      break
    case 'accept': {
      const keys = new Set(ev.keys ?? [])
      await update($, acceptedAtom, list => (ev.on ? [...new Set([...list, ...keys])] : list.filter(k => !keys.has(k))))
      break
    }
    case 'acceptFiles': {
      // « Tout accepter » d'un prompt : chaque fichier encore en revue sort de la revue
      const paths = (ev.paths ?? []).filter((x): x is string => typeof x === 'string')
      for (const path of paths) await closeReview($, path)
      if (paths.length)
        await notify($, { type: 'toast', text: `✅ ${paths.length} fichier${paths.length > 1 ? 's' : ''} validé${paths.length > 1 ? 's' : ''} : revue close pour ce prompt` })
      break
    }
    case 'acceptFile':
      // tout le fichier est validé : sa revue est close pour ce prompt. Il redevient un fichier
      // ordinaire (édition normale, onglet fermable) ; une nouvelle modif de Claude le rouvre.
      if (!ev.path) break
      await closeReview($, ev.path)
      await notify($, { type: 'toast', text: `✅ ${relTo(cwd, ev.path)} validé : revue close pour ce prompt` })
      break
    case 'sendReview': {
      if (!(await read($, reviewAtom)).length) break
      // comme un prompt de la page : la revue en attente y est jointe ; en file si Claude travaille
      const text = 'Voici ma review de tes modifications.'
      if (await read($, busyAtom)) {
        await update($, queueAtom, q => [...q, { id: newId(), text, at: Date.now() }])
        await notify($, { type: 'toast', text: '⏳ Review en file d’attente : elle partira quand Claude aura fini' })
      } else {
        await submitPrompt($, text)
        await notify($, { type: 'toast', text: '📨 Review envoyée à Claude' })
      }
      break
    }
    case 'restore':
      if (typeof ev.turnId === 'number') await restoreTo($, ev.turnId, ev.force === true)
      break
    case 'selection':
      // un extrait de code rejoint la liste d'attente, comme un commentaire
      if (!ev.path || !ev.code) break
      await addReview($, { kind: 'snippet', path: ev.path, line: ev.startLine, endLine: ev.endLine, code: ev.code, text: ev.text ?? '' })
      await notify($, { type: 'toast', text: '📎 Extrait ajouté : il partira avec ton prochain prompt' })
      break
    case 'tests':
      // la sortie d'un lancement de tests, jointe depuis la page
      await addReview($, { kind: 'tests', text: ev.text ?? 'Résultat des tests', code: ev.code })
      await notify($, { type: 'toast', text: '📎 Sortie de la commande ajoutée : elle partira avec ton prochain prompt' })
      break
    // --- éditeur de prompt ---
    case 'prompt.send':
      if (!ev.text?.trim()) return
      if (await read($, busyAtom)) {
        await update($, queueAtom, q => [...q, { id: newId(), text: ev.text!.trim(), at: Date.now() }])
        await notify($, { type: 'toast', text: `⏳ En file d'attente : il partira quand Claude aura fini` })
      } else await submitPrompt($, ev.text)
      break
    case 'queue.remove':
      await update($, queueAtom, q => q.filter(x => x.id !== ev.id))
      break
    case 'queue.now': {
      // envoyer tout de suite : Claude Code le prendra dès qu'il sera libre
      const item = (await read($, queueAtom)).find(x => x.id === ev.id)
      if (!item) break
      await update($, queueAtom, q => q.filter(x => x.id !== ev.id))
      await submitPrompt($, item.text)
      break
    }
    case 'busy.reset':
      // si Claude a été interrompu sans fin de tour, la file ne doit pas rester bloquée
      await update($, busyAtom, () => false)
      await drainQueue($)
      break
    // --- boîte à idées ---
    case 'idea.add':
      if (!ev.text?.trim()) break
      {
        const idea = await addIdea($, {
          text: ev.text.trim(),
          tags: Array.isArray(ev.tags) ? ev.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [],
          by: 'user',
          ...(ev.path ? { path: ev.path, line: ev.line, endLine: ev.endLine, code: ev.code } : {}),
        })
        await notify($, { type: 'toast', text: `💡 Idée #i${idea.n} ajoutée` })
      }
      break
    case 'idea.update':
      await changeProject($, p => ({
        ...p,
        ideas: p.ideas.map(i =>
          i.id !== ev.id
            ? i
            : {
                ...i,
                ...(typeof ev.text === 'string' && ev.text.trim() ? { text: ev.text.trim() } : {}),
                ...(Array.isArray(ev.tags) ? { tags: ev.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()) } : {}),
                ...(ev.status === 'new' || ev.status === 'doing' || ev.status === 'done' ? { status: ev.status } : {}),
              },
        ),
      }))
      break
    case 'idea.delete':
      await changeProject($, p => ({ ...p, ideas: p.ideas.filter(i => i.id !== ev.id) }))
      break
    case 'idea.attach': {
      const idea = (await getProject($)).ideas.find(i => i.id === ev.id)
      if (!idea) break
      await addReview($, { kind: 'idea', text: ideaText(cwd, idea), path: idea.path, line: idea.line, endLine: idea.endLine })
      await changeProject($, p => ({ ...p, ideas: p.ideas.map(i => (i.id === idea.id && i.status === 'new' ? { ...i, status: 'doing' } : i)) }))
      await notify($, { type: 'toast', text: `📎 Idée #i${idea.n} jointe : elle partira avec ton prochain prompt` })
      break
    }
    // --- annotations ---
    case 'annotation.delete':
      await changeProject($, p => ({ ...p, annotations: p.annotations.filter(a => a.id !== ev.id) }))
      break
    case 'annotation.clear':
      await changeProject($, p => ({ ...p, annotations: [] }))
      break
    // --- commandes enregistrées ---
    case 'command.save': {
      const name = ev.name?.trim()
      const command = ev.command?.trim()
      if (!name || !command) break
      await changeProject($, p => {
        const old = p.commands.find(c => c.id === ev.id || c.name === name)
        const saved: SavedCommand = { id: old?.id ?? newId(), name, command, description: ev.description?.trim() || undefined, by: 'user', at: Date.now() }
        return { ...p, commands: old ? p.commands.map(c => (c.id === old.id ? saved : c)) : [...p.commands, saved] }
      })
      await notify($, { type: 'toast', text: `💾 Commande « ${name} » enregistrée` })
      break
    }
    case 'command.delete':
      await changeProject($, p => ({ ...p, commands: p.commands.filter(c => c.id !== ev.id) }))
      break
    // --- réglages ---
    case 'ide.set':
      if (ev.settings && typeof ev.settings === 'object') await setIdeSettings($, ev.settings as Partial<IdeSettings>)
      break
    case 'editor.set':
      if (ev.settings && typeof ev.settings === 'object') await $.store.set('editor', ev.settings)
      break
    case 'editor.importVSCode':
      await notify($, { type: 'toast', text: await importVSCode($) })
      break
    case 'config.load':
      await sendConfig($)
      return
    case 'config.set':
      if (!ev.key) return
      try {
        await $.config.set({ key: ev.key, value: ev.value as never })
        await notify($, { type: 'toast', text: `⚙️ ${ev.key} enregistré` })
      } catch (err) {
        await notify($, { type: 'toast', text: `⚠️ ${ev.key} : ${String((err as Error)?.message ?? err)}` })
      }
      await sendConfig($)
      return
    case 'settings.save': {
      const path = ev.scope ? (await settingsFiles($))[ev.scope] : undefined
      if (!path || typeof ev.text !== 'string') return
      try {
        JSON.parse(ev.text)
      } catch (err) {
        await notify($, { type: 'toast', text: `⚠️ JSON invalide : ${String((err as Error)?.message ?? err)}` })
        return
      }
      // copie de sécurité de la version d'avant, à côté du fichier
      const old = await $.fs.read(path).catch(() => null)
      if (typeof old === 'string') await $.fs.write(`${path}.bak`, old)
      await $.fs.write(path, ev.text)
      await notify($, { type: 'toast', text: `💾 ${path.split('/').slice(-2).join('/')} enregistré (copie de l'ancien en .bak)` })
      await sendConfig($)
      return
    }
    case 'status.refresh':
      await refreshStatus($, true)
      return
    case 'prefs':
      await $.store.set(prefsKey(cwd), ev.prefs ?? null)
      return
    default:
      return
  }
  void pushChanges($).catch(() => undefined)
  void persist($)
}

/** Démarre le serveur de cette session s'il ne tourne pas, et rend son adresse. */
function startWeb($: $): Promise<string> {
  if (server) return server
  ready = false
  server = (async () => {
    const cwd = await $.session.cwd()
    const prev = await read($, webAtom)
    const token = prev?.token ?? randomToken()
    const argv = ['node', `${$.plugin.root}/server/server.mjs`, '--root', cwd, '--token', token]
    if (prev) {
      // un ancien serveur de la session peut encore tourner, lancé par une copie précédente
      // de la mod : plus personne ne lit ce que la page lui envoie. On l'arrête et on reprend son port.
      await $.http
        .fetch(`http://127.0.0.1:${prev.port}/api/quit`, { method: 'POST', headers: { 'x-token': prev.token } })
        .catch(() => undefined)
      argv.push('--port', String(prev.port))
    }
    const child = $.process.spawn({ argv })
    let resolvePort: (port: number) => void = () => undefined
    let rejectPort: (err: Error) => void = () => undefined
    const port = new Promise<number>((ok, ko) => ((resolvePort = ok), (rejectPort = ko)))
    // la boucle vit avec le serveur ; elle s'arrête avec la session ou au rechargement de la mod
    void (async () => {
      let buf = ''
      let errors = ''
      try {
        for await (const chunk of child) {
          if (chunk.stream === 'stderr') {
            errors += chunk.text
            continue
          }
          buf += chunk.text
          let nl = buf.indexOf('\n')
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            nl = buf.indexOf('\n')
            let msg: { port?: number; event?: WebEvent } = {}
            try {
              msg = JSON.parse(line)
            } catch {
              continue
            }
            if (typeof msg.port === 'number') resolvePort(msg.port)
            if (msg.event) await onWebEvent($, msg.event).catch(() => undefined)
          }
        }
      } catch (err) {
        rejectPort(new Error(String((err as Error)?.message ?? err)))
      }
      rejectPort(new Error(errors.trim() || 'le serveur s’est arrêté'))
      server = null
      ready = false
    })()
    const p = await port
    await update($, webAtom, () => ({ port: p, token }))
    ready = true
    await pushChanges($)
    const url = `http://127.0.0.1:${p}/?t=${token}`
    // le port d'avant n'a pas pu être repris : l'onglet ouvert pointe dans le vide
    if (prev && prev.port !== p) {
      await update($, noticeAtom, () => `🌐 Page web déplacée : ${url}`)
      void openBrowser($, url)
    }
    return url
  })()
  server.catch(() => {
    server = null
    failedAt = Date.now()
  })
  return server
}

/** Retire un fichier de la revue en cours : plus de surlignage ni de blocs validés pour lui. */
async function closeReview($: $, path: string) {
  await update($, changesAtom, list => list.filter(c => c.path !== path))
  await update($, acceptedAtom, list => list.filter(k => !k.startsWith(path + '|')))
}

/** Les fichiers de la revue qui n'existent plus (supprimés hors de la page) en sortent. */
async function pruneGone($: $) {
  const list = await read($, changesAtom)
  const gone: string[] = []
  for (const c of list) if (!(await $.fs.exists(c.path).catch(() => true))) gone.push(c.path)
  for (const p of gone) await closeReview($, p)
  return gone.length > 0
}

/** La page web a écrit un fichier. Une sauvegarde à toi efface le surlignage Claude ; un rejet de bloc le garde. */
async function onWebSave($: $, path: string, dropHighlight = true) {
  if (dropHighlight) await update($, changesAtom, list => list.filter(c => c.path !== path))
  const file = await read($, fileAtom)
  if (file?.path === path && file.draft === file.saved) {
    const text = await readText($, path).catch(() => null)
    if (text !== null) await update($, fileAtom, () => ({ path, saved: text, draft: text }))
  }
}

/** xdg-open sous Linux, open sous macOS ; l'URL passe en argument, jamais dans le script.
 *  Sans sh (Windows), rundll32 ouvre l'URL dans le navigateur par défaut, sans passer par cmd. */
async function openBrowser($: $, url: string) {
  const opener = 'if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$1"; else exec open "$1"; fi'
  await $.process
    .run(['sh', '-c', opener, 'sh', url])
    .catch(() => $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url]))
    .catch(() => undefined)
}

async function openWeb($: $): Promise<string> {
  try {
    const url = await startWeb($)
    const file = await read($, fileAtom)
    const full = file ? `${url}#${encodeURIComponent(file.path)}` : url
    await openBrowser($, full)
    return full
  } catch (err) {
    await update($, noticeAtom, () => `⚠️ Serveur web : ${String((err as Error)?.message ?? err)}`)
    throw err
  }
}

// ---------- activité de Claude, en direct dans la page ----------
function activityLabel(cwd: string, e: { tool: string } & Record<string, unknown>): string {
  const p = typeof e.file_path === 'string' ? relTo(cwd, e.file_path) : typeof e.path === 'string' ? relTo(cwd, e.path) : ''
  switch (e.tool) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ modifie ${p}`
    case 'Read':
      return `📖 lit ${p}`
    case 'Bash':
      return `⚙️ lance ${String(e.command ?? '').split('\n')[0]!.slice(0, 60)}`
    case 'Grep':
    case 'Glob':
      return `🔎 cherche ${String(e.pattern ?? '').slice(0, 40)}`
    case 'Agent':
    case 'Task':
      return '🧑‍🤝‍🧑 lance un sous-agent'
    case 'WebFetch':
    case 'WebSearch':
      return '🌐 consulte le web'
    default:
      return `🔧 ${e.tool}`
  }
}

// ---------- module ----------
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ide-for-claude', description: 'Ouvre l’éditeur (option : un fichier)' })
    await $.command.register({ name: 'ide-for-claude-web', description: 'Ouvre IDE for Claude dans le navigateur (Monaco, diff des modifs de Claude)' })
    // une session reprise retrouve son historique ; ses fichiers supprimés depuis sortent de la revue
    await ensureRestored($).catch(() => null)
    await pruneGone($).catch(() => false)
    await loadPanePrefs($).catch(() => undefined)
    for (const t of TOOLS) await $.tool.register({ ...t, inputSchema: t.inputSchema as Record<string, unknown>, isDeferred: false }).catch(() => undefined)
    await getProject($).catch(() => null)
    void pruneSessions($).catch(() => undefined)
    // après un rechargement de la mod, on relance le serveur sur le même port : la page ouverte se reconnecte
    if (await read($, webAtom)) void startWeb($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ide-for-claude' }, async ($, e) => {
    const arg = e.args.trim()
    await ensureRestored($).catch(() => null)
    if (arg) await openFile($, absOf(await $.session.cwd(), arg))
    await update($, paneClosedAtom, () => false)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'IDE for Claude ouvert.' }
  })

  on('command.run', { command: 'ide-for-claude-web' }, async $ => {
    await ensureRestored($).catch(() => null)
    try {
      const url = await openWeb($)
      return { text: `IDE for Claude ouvert dans le navigateur : ${url}` }
    } catch (err) {
      return { text: `Impossible de lancer le serveur web : ${String((err as Error)?.message ?? err)}` }
    }
  })

  // un nouveau prompt : nouveau tour d'historique, et la review en attente part avec lui
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    await ensureRestored($).catch(() => null)
    await update($, changesAtom, list => list.map(c => ({ ...c, stale: true })))
    await newTurn($, e.text)
    await update($, busyAtom, () => true)
    const block = (await ideSettings($)).attachReview ? await reviewBlock($) : null
    if (block) {
      await update($, reviewAtom, () => [])
      void notify($, { type: 'toast', text: '📨 Review jointe à ton prompt' })
    }
    void pushChanges($).catch(() => undefined)
    void persist($)
    return block ? next({ ...e, context: [...(e.context ?? []), block] }) : next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => track($, e.file_path, { agent: await agentLabel($, e.agentId) }, () => next(e)))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => track($, e.file_path, { agent: await agentLabel($, e.agentId) }, () => next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    track($, e.notebook_path, { agent: await agentLabel($, e.agentId), via: 'NotebookEdit' }, () => next(e)),
  )

  // Bash : photo avant, comparaison après. Une commande lancée en arrière-plan
  // n'est vue que pour ce qu'elle a changé avant de rendre la main.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const snap = await snapshot($).catch(() => null)
    const result = await next(e)
    if (snap) await diffSnapshot($, snap, { agent: await agentLabel($, e.agentId), via: 'Bash' }).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    await endSession($, e.sessionId, String(e.reason)).catch(() => undefined)
    return next(e)
  })

  // fermé à la croix, par Échap ou par « Quitter » : on ne le rouvre plus tout seul
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, paneClosedAtom, () => true)
    return next(e)
  })

  // le plan de Claude : sa liste de tâches, en direct dans la page (celle de Claude, pas des sous-agents)
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && Array.isArray(e.todos)) {
      await update($, planAtom, () => e.todos.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm })))
      void pushChanges($).catch(() => undefined)
    }
    return done
  })

  on('tool.call', { tool: `${TOOL_PREFIX}idea_add` }, async ($, e) => {
    const a = e as unknown as { text?: string; tags?: unknown; file?: string; line?: number; endLine?: number }
    if (!a.text?.trim()) return toolText('Il manque le texte de l’idée.', true)
    const cwd = await $.session.cwd()
    let code: string | undefined
    const path = a.file ? absOf(cwd, a.file) : undefined
    if (path && a.line) {
      const text = await readText($, path).catch(() => null)
      if (text !== null) code = text.split('\n').slice(a.line - 1, Math.max(a.line, a.endLine ?? a.line)).join('\n')
    }
    const idea = await addIdea($, {
      text: a.text.trim(),
      tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string') : [],
      by: 'claude',
      ...(path ? { path, line: a.line, endLine: a.endLine, code } : {}),
    })
    void notify($, { type: 'toast', text: `💡 Claude a noté l'idée #i${idea.n}` })
    return toolText(`Idée #i${idea.n} notée dans la boîte à idées du projet.`)
  })

  on('tool.call', { tool: `${TOOL_PREFIX}annotate` }, async ($, e) => {
    const a = e as unknown as { file?: string; line?: number; endLine?: number; note?: string }
    if (!a.file || !a.line || !a.note?.trim()) return toolText('Il faut un fichier, une ligne et une note.', true)
    const cwd = await $.session.cwd()
    const path = absOf(cwd, a.file)
    if (!(await $.fs.exists(path).catch(() => false))) return toolText(`Fichier introuvable : ${a.file}`, true)
    const ann: Annotation = { id: newId(), path, line: a.line, ...(a.endLine && a.endLine > a.line ? { endLine: a.endLine } : {}), note: a.note.trim(), at: Date.now() }
    await changeProject($, p => ({ ...p, annotations: [...p.annotations, ann] }))
    void notify($, { type: 'annotation', id: ann.id })
    return toolText(`Annotation posée sur ${relTo(cwd, path)}:${a.line}. L'utilisateur la voit dans l'onglet 📍 d'IDE for Claude.`)
  })

  on('tool.call', { tool: `${TOOL_PREFIX}annotations_clear` }, async ($, e) => {
    const a = e as unknown as { file?: string }
    const cwd = await $.session.cwd()
    const only = a.file ? absOf(cwd, a.file) : null
    let n = 0
    await changeProject($, p => {
      const kept = p.annotations.filter(x => only !== null && x.path !== only)
      n = p.annotations.length - kept.length
      return { ...p, annotations: kept }
    })
    return toolText(`${n} annotation${n > 1 ? 's' : ''} retirée${n > 1 ? 's' : ''}.`)
  })

  on('tool.call', { tool: `${TOOL_PREFIX}command_save` }, async ($, e) => {
    const a = e as unknown as { name?: string; command?: string; description?: string }
    const name = a.name?.trim()
    const command = a.command?.trim()
    if (!name || !command) return toolText('Il faut un nom et une commande.', true)
    await changeProject($, p => {
      const old = p.commands.find(c => c.name === name)
      const saved: SavedCommand = { id: old?.id ?? newId(), name, command, description: a.description?.trim() || undefined, by: 'claude', at: Date.now() }
      return { ...p, commands: old ? p.commands.map(c => (c.id === old.id ? saved : c)) : [...p.commands, saved] }
    })
    void notify($, { type: 'toast', text: `💾 Claude a enregistré la commande « ${name} »` })
    return toolText(`Commande « ${name} » enregistrée dans l'exécuteur d'IDE for Claude (onglet ▶).`)
  })

  on('tool.call', { tool: `${TOOL_PREFIX}statusline_set` }, async ($, e) => {
    const a = e as unknown as { template?: string }
    if (!a.template?.trim()) return toolText('Il manque le modèle.', true)
    await setIdeSettings($, { statusline: a.template.trim() })
    return toolText(`Barre d'état mise à jour : ${a.template.trim()}`)
  })

  // activité en direct, et fin de tour pour la notification
  on('tool.call', async ($, e, next) => {
    if (!(await read($, webAtom))) return next(e)
    const cwd = await $.session.cwd()
    void notify($, { type: 'activity', label: activityLabel(cwd, e as unknown as { tool: string } & Record<string, unknown>) })
    try {
      return await next(e)
    } finally {
      void notify($, { type: 'activity', label: null })
      void refreshStatus($)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await update($, busyAtom, () => false)
      await persist($)
      if (await read($, webAtom)) {
        void notify($, { type: 'done' })
        void refreshStatus($, true)
      }
      // pas d'attente ici : le prompt suivant ne part qu'une fois ce tour fini
      void drainQueue($).catch(() => undefined)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    const cols = Math.max(24, e.props.bodyColumns ?? 60)
    const bodyRows = Math.max(10, e.props.scroll?.bodyRows ?? 24)
    const file = await read($, fileAtom)
    const mode = await read($, modeAtom)
    const notice = await read($, noticeAtom)
    const hasUndo = (await read($, undoAtom)) !== null
    const changes = await read($, changesAtom)
    const change = file ? changes.find(c => c.path === file.path) : undefined
    const showTree = await read($, showTreeAtom)
    const full = await read($, fullAtom)
    const wide = cols >= 90
    const treeCols = wide ? 30 : cols
    const edCols = showTree && wide ? cols - treeCols - 1 : cols

    // ---------- arbre : dossiers des fichiers modifiés ouverts, le reste réduit ----------
    const changedSet = new Set(changes.map(c => c.path))
    const autoOpen = new Set<string>()
    for (const c of changes) {
      if (!c.path.startsWith(cwd + '/')) continue
      let d = c.path.slice(0, c.path.lastIndexOf('/'))
      while (d.length > cwd.length) {
        autoOpen.add(d)
        d = d.slice(0, d.lastIndexOf('/'))
      }
    }
    const toggled = new Set(await read($, toggledAtom))
    const isOpenDir = (d: string) => autoOpen.has(d) !== toggled.has(d)
    const hasChange = (d: string) => [...changedSet].some(p => p.startsWith(d + '/'))
    const toggle = (d: string) => () =>
      void update($, toggledAtom, list => (list.includes(d) ? list.filter(x => x !== d) : [...list, d]))
    type Row = { key: string; depth: number; label: string; color?: string; dim: boolean; onPress: () => void }
    const rows: Row[] = []
    const walk = async (dir: string, depth: number) => {
      const entries = (await $.fs.list(dir).catch(() => []))
        .filter(x => !HIDDEN.has(x.name))
        .sort((x, y) => (x.kind === 'dir' ? 0 : 1) - (y.kind === 'dir' ? 0 : 1) || x.name.localeCompare(y.name))
      for (const x of entries) {
        if (rows.length >= MAX_TREE) return
        const path = `${dir}/${x.name}`
        if (x.kind === 'dir') {
          const open = isOpenDir(path)
          const touched = hasChange(path)
          rows.push({ key: `d:${path}`, depth, label: `${open ? '▾' : '▸'} ${x.name}/`, color: touched ? 'claude' : undefined, dim: !touched, onPress: toggle(path) })
          if (open) await walk(path, depth + 1)
        } else {
          const touched = changedSet.has(path)
          const isCur = file?.path === path
          rows.push({
            key: `f:${path}`,
            depth,
            label: `${touched ? '✏️' : '  '} ${x.name}${isCur ? ' ◀' : ''}`,
            color: touched ? 'claude' : undefined,
            dim: !touched && !isCur,
            onPress: () =>
              void openFile($, path).then(() => (wide ? undefined : update($, showTreeAtom, () => false))),
          })
        }
      }
    }
    if (showTree) await walk(cwd, 0)
    const nChanged = changes.filter(c => c.path.startsWith(cwd + '/')).length
    const tree = showTree && (
      <Box flexDirection="column" width={treeCols} marginBottom={wide ? 0 : 1}>
        <Text color="claude">{cut(`✏️ ${nChanged} modifié${nChanged > 1 ? 's' : ''} par Claude`, treeCols)}</Text>
        {rows.map(r => (
          <Button key={r.key} plain dimColor={r.dim} onPress={r.onPress}>
            {r.color ? <Text color={r.color}>{cut('  '.repeat(r.depth) + r.label, treeCols)}</Text> : cut('  '.repeat(r.depth) + r.label, treeCols)}
          </Button>
        ))}
        {rows.length >= MAX_TREE && <Text dimColor>…</Text>}
      </Box>
    )
    const isDirty = file !== null && file.draft !== file.saved

    // ---------- onglets : un par fichier modifié par Claude, touches 1 à 9 ----------
    const tabs = changes.length > 0 && (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {changes.map((c, i) => {
          const isCur = file?.path === c.path
          const label = `${i < 9 ? i + 1 : '·'} ${c.path.split('/').pop()}`
          return (
            <Button
              key={`tab:${c.path}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              plain
              dimColor={!isCur}
              onPress={() => void openFile($, c.path)}
            >
              {isCur ? <Text color="claude" weight="bold">{`[${label}]`}</Text> : ` ${label} `}
            </Button>
          )
        })}
      </Box>
    )

    // barre du haut, comme nano
    const name = file ? relTo(cwd, file.path) : 'Nouveau tampon'
    const right = isDirty ? 'Modifié' : change ? '✏️ modifié par Claude' : ''
    const titleText = `  IDE for Claude   ${name}`
    const header = (
      <Text color="inverseText" backgroundColor="text">
        {cut(titleText.padEnd(Math.max(0, cols - right.length - 1)) + right + ' ', cols).padEnd(cols)}
      </Text>
    )

    let body
    if (!file) {
      body = <Text dimColor>Aucun fichier. Tape /ide-for-claude chemin/du/fichier pour en ouvrir un.</Text>
    } else if (mode === 'edit') {
      body = (
        <Input
          key="editor"
          autoFocus
          rows={Math.min(60, Math.max(5, bodyRows - 5))}
          value={file.draft}
          submitLabel="valider"
          onInput={value => void update($, fileAtom, f => (f ? { ...f, draft: value } : f))}
          onSubmit={value => void update($, fileAtom, f => (f ? { ...f, draft: value } : f))}
        />
      )
    } else {
      const lines = change
        ? diffLines(change.before, file.draft)
        : file.draft.split('\n').map((text, i) => ({ op: ' ' as const, text, no: i + 1 }))
      const numW = String(lines.length).length
      const lang = langOf(file.path)
      const state = start()
      // on colore toutes les lignes (pour garder l'état des commentaires et blocs), puis on replie
      const toks = lines.map(l => tokenize(l.text.replace(/\t/g, '  '), lang, state))
      const keep = lines.map(() => !change || full)
      if (change && !full)
        lines.forEach((l, i) => {
          if (l.op !== ' ') for (let k = i - CONTEXT; k <= i + CONTEXT; k++) if (k >= 0 && k < lines.length) keep[k] = true
        })
      type Shown = { i: number } | { fold: number }
      const shown: Shown[] = []
      let hidden = 0
      lines.forEach((_, i) => {
        if (!keep[i]) return void hidden++
        if (hidden) shown.push({ fold: hidden })
        hidden = 0
        shown.push({ i })
      })
      if (hidden) shown.push({ fold: hidden })
      body = (
        <Box flexDirection="column">
          {shown.slice(0, MAX_LINES).map(row => {
            if ('fold' in row)
              return <Text dimColor>{cut(`${' '.repeat(numW)}   ··· ${row.fold} ligne${row.fold > 1 ? 's' : ''} ···`, edCols)}</Text>
            const l = lines[row.i]!
            const prefix = `${(l.no === undefined ? '' : String(l.no)).padStart(numW)} ${l.op === ' ' ? '│' : l.op} `
            const line: Tok[] = cutToks(toks[row.i]!, Math.max(1, edCols - prefix.length))
            const used = prefix.length + line.reduce((n, t) => n + t.text.length, 0)
            return (
              <Text backgroundColor={l.op === '+' ? 'diffAdded' : l.op === '-' ? 'diffRemoved' : undefined}>
                <Text dimColor={l.op === ' '}>{prefix}</Text>
                {line.map(t => (t.kind ? <Text color={COLORS[t.kind]}>{t.text}</Text> : t.text))}
                {' '.repeat(Math.max(0, edCols - used))}
              </Text>
            )
          })}
          {shown.length > MAX_LINES && <Text dimColor>… {shown.length - MAX_LINES} lignes de plus</Text>}
        </Box>
      )
    }

    // barre du bas, comme nano
    const footer = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {file && mode === 'view' && <Button key="edit" hotkey="e" plain onPress={() => void update($, modeAtom, () => 'edit' as Mode)}>Éditer</Button>}
        {file && mode === 'edit' && <Button key="view" hotkey="v" plain onPress={() => void update($, modeAtom, () => 'view' as Mode)}>Voir</Button>}
        {file && <Button key="save" hotkey="s" plain onPress={() => void save($)}>Sauver</Button>}
        {change && mode === 'view' && (
          <Button key="full" hotkey="a" plain onPress={() => void update($, fullAtom, v => !v).then(() => savePanePrefs($))}>{full ? 'Replier' : 'Tout voir'}</Button>
        )}
        <Button key="tree" hotkey="t" plain onPress={() => void update($, showTreeAtom, v => !v).then(() => savePanePrefs($))}>{showTree ? 'Cacher arbre' : 'Arbre'}</Button>
        {file && <Button key="reload" hotkey="r" plain onPress={() => void openFile($, file.path)}>Recharger</Button>}
        {hasUndo && <Button key="undo" hotkey="z" plain onPress={() => void undoSave($)}>Annuler sauvegarde</Button>}
        <Button key="web" hotkey="w" plain onPress={() => void openWeb($).catch(() => undefined)}>Navigateur</Button>
        <Button
          key="quit"
          hotkey="q"
          plain
          // notre propre $.ui.close ne passe pas par notre hook ui.close : on note la fermeture ici
          onPress={() => void update($, paneClosedAtom, () => true).then(() => $.ui.close({ id: PANE }))}
        >
          Quitter
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {tabs}
        {wide ? (
          <Box flexDirection="row" columnGap={1}>
            {tree}
            <Box flexDirection="column" flexGrow={1}>{body}</Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {tree}
            {body}
          </Box>
        )}
        {notice !== '' && <Text color="suggestion">{cut(notice, cols)}</Text>}
        {change && mode === 'view' && (
          <Text dimColor>{cut('vert = ajouté par Claude · rouge = retiré par Claude', cols)}</Text>
        )}
        {mode === 'edit' && <Text dimColor>{cut('Échap pour sortir du champ, puis s pour sauver', cols)}</Text>}
        {footer}
      </Box>
    )
  })
}
