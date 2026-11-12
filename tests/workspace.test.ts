import { expect, test } from 'claude-code/testing'

import type { Annotation, Idea, PlanItem, Queued, SavedCommand } from '../types'

type On = Parameters<Parameters<typeof test>[1]>[1]
const PROJECTS = '/home/moi/.claude/plugins/data/ide-for-claude/projects/'
const T = 'mcp__ide-for-claude__'
/** ce que Claude lit en retour d'un outil de la mod : du texte, ou un refus en cas d'erreur */
const said = (r: unknown) => {
  const x = r as { result?: unknown; deny?: string }
  // Claude Code n'accepte qu'un texte (ou une liste de blocs) comme résultat d'un outil de plugin
  if (x.deny === undefined && typeof x.result !== 'string') throw new Error(`résultat d'outil refusé par Claude Code : ${JSON.stringify(x.result)}`)
  return { text: x.deny ?? (x.result as string), isError: x.deny !== undefined }
}


/** Une session dans /p, un disque en mémoire, et ce que la mod écrit dans son état. */
function workspace(on: On, files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files))
  const state: Record<string, unknown> = {}
  const waiters: { pred: () => boolean; done: () => void }[] = []
  on('session.cwd', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'abc' }))
  on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/moi' : undefined }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.list', () => ({ value: [{ name: 'review', description: 'Relit le code', source: 'builtin' }] }))
  on('fs.exists', (_$, e) => ({ value: disk.has(e.path) }))
  on('fs.stat', (_$, e) => (disk.has(e.path) ? { value: { kind: 'file' as const, size: disk.get(e.path)!.length, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_$, e) => (disk.has(e.path) ? { value: disk.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => (disk.set(e.path, e.text), { value: undefined }))
  // un dossier liste ce que le disque en mémoire contient dessous
  const mtimes = new Map<string, number>()
  on('fs.list', (_$, e) => {
    const dir = ((e as { path?: string }).path ?? '/p').replace(/\/$/, '')
    const seen = new Map<string, 'file' | 'dir'>()
    for (const k of disk.keys()) {
      if (!k.startsWith(dir + '/')) continue
      const [name, ...more] = k.slice(dir.length + 1).split('/')
      seen.set(name!, more.length ? 'dir' : 'file')
    }
    return {
      value: [...seen].map(([name, kind]) => {
        const path = `${dir}/${name}`
        return { name, kind, size: kind === 'file' ? disk.get(path)!.length : 0, mtimeMs: mtimes.get(path) ?? 1, isLink: false }
      }),
    }
  })
  on('state.set', ($, e, next) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    state[w.key] = w.value.value
    for (const x of [...waiters]) if (x.pred()) (waiters.splice(waiters.indexOf(x), 1), x.done())
    return next(e)
  })
  const until = (pred: () => boolean) => (pred() ? Promise.resolve() : new Promise<void>(done => waiters.push({ pred, done })))
  const project = () => {
    const file = [...disk.keys()].find(k => k.startsWith(PROJECTS))
    return file ? (JSON.parse(disk.get(file)!) as { ideas: Idea[]; annotations: Annotation[]; commands: SavedCommand[] }) : null
  }
  return { disk, state, until, project, mtimes }
}

/** La page est ouverte : la mod reçoit ses événements, et ce qu'elle lui renvoie (/api/notify) est gardé. */
function page(on: On, w: ReturnType<typeof workspace>, events: object[]) {
  const notified: Record<string, unknown>[] = []
  const waiters: { type: string; done: (x: Record<string, unknown>) => void }[] = []
  on('http.fetch', (_$, e) => {
    if (e.url.endsWith('/api/notify')) {
      const body = JSON.parse(String(e.init?.body ?? '{}')) as Record<string, unknown>
      notified.push(body)
      for (const x of [...waiters]) if (x.type === body.type) (waiters.splice(waiters.indexOf(x), 1), x.done(body))
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('state.get', ($, e, next) =>
    (e as unknown as { key: string }).key === 'web' && !('web' in w.state)
      ? { value: { value: { shape: 'web-1', value: { port: 61077, token: 'cle' } }, version: 1 } }
      : next(e),
  )
  let stop = () => {}
  const alive = new Promise<void>(r => (stop = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":61077}\n' }
    for (const event of events) yield { stream: 'stdout' as const, text: JSON.stringify({ event }) + '\n' }
    await alive
    return { value: { code: 0, signal: null } }
  })
  const next = (type: string) => new Promise<Record<string, unknown>>(done => waiters.push({ type, done }))
  return { notified, next, stop }
}

test('Claude note une idée, pose une annotation et enregistre une commande', async ($, on) => {
  const w = workspace(on, { '/p/src/app.ts': 'un\ndeux\ntrois\n' })

  const idea = await $.tool.call({ tool: `${T}idea_add`, text: 'Gérer le cache', file: 'src/app.ts', line: 2 } as never)
  expect(said(idea).text).toContain('#i1')
  const ann = await $.tool.call({ tool: `${T}annotate`, file: 'src/app.ts', line: 3, note: 'la config est lue ici' } as never)
  expect(said(ann).text).toContain('src/app.ts:3')
  const missing = await $.tool.call({ tool: `${T}annotate`, file: 'nulle/part.ts', line: 1, note: 'x' } as never)
  expect(said(missing).isError).toBe(true)
  await $.tool.call({ tool: `${T}command_save`, name: 'Serveur de dev', command: 'npm run dev' } as never)

  const p = w.project()!
  expect(p.ideas[0]).toMatchObject({ n: 1, text: 'Gérer le cache', path: '/p/src/app.ts', line: 2, code: 'deux', by: 'claude', status: 'new' })
  expect(p.annotations.map(a => [a.path, a.line, a.note])).toEqual([['/p/src/app.ts', 3, 'la config est lue ici']])
  expect(p.commands.map(c => [c.name, c.command, c.by])).toEqual([['Serveur de dev', 'npm run dev', 'claude']])

  const cleared = await $.tool.call({ tool: `${T}annotations_clear` } as never)
  expect(said(cleared).text).toContain('1 annotation')
  expect(w.project()!.annotations).toEqual([])
})

test('le plan de Claude suit sa liste TodoWrite', async ($, on) => {
  const w = workspace(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} as never }))
  const todos: PlanItem[] = [
    { content: 'Lire le code', status: 'completed', activeForm: 'Lit le code' },
    { content: 'Écrire les tests', status: 'in_progress', activeForm: 'Écrit les tests' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  expect(w.state.plan).toEqual(todos)
})

test('un prompt envoyé pendant que Claude travaille attend son tour, puis part avec ses mentions', async ($, on) => {
  const w = workspace(on, { '/p/a.ts': 'l1\nl2\nl3\n' })
  on('turn.complete', () => ({ text: '' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  // ce que reçoit le moteur quand le prompt part
  const sent: { text: string; context: readonly string[] }[] = []
  let arrived = () => {}
  const isSent = new Promise<void>(r => (arrived = r))
  on('prompt.submit', (_$, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })
    if (e.text.startsWith('explique')) arrived()
    return { text: e.text }
  })
  // une page est déjà ouverte et Claude travaille (un prompt tapé dans le terminal) :
  // ces valeurs tiennent jusqu'à ce que la mod les réécrive
  const before: Record<string, unknown> = { web: { port: 61077, token: 'cle' }, busy: true }
  on('state.get', ($, e, next) => {
    const key = (e as unknown as { key: string }).key
    return key in before && !(key in w.state) ? { value: { value: { shape: `${key}-1`, value: before[key] }, version: 1 } } : next(e)
  })
  let stop = () => {}
  const alive = new Promise<void>(r => (stop = r))
  let go = () => {}
  const ready = new Promise<void>(r => (go = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":61077}\n' }
    await ready
    // la page envoie un prompt avec une mention de lignes et une commande
    yield { stream: 'stdout' as const, text: JSON.stringify({ event: { type: 'prompt.send', text: 'explique @a.ts:2-3 avec /review' } }) + '\n' }
    await alive
    return { value: { code: 0, signal: null } }
  })

  // une action quelconque de la mod la reconnecte à la page, qui envoie alors son prompt
  await $.tool.call({ tool: `${T}command_save`, name: 'x', command: 'true' } as never)
  go()
  await w.until(() => ((w.state.queue as Queued[] | undefined) ?? []).length === 1)
  expect((w.state.queue as Queued[])[0]!.text).toBe('explique @a.ts:2-3 avec /review')

  // fin du tour : le prompt en attente part
  await $.turn.complete({ answer: '' } as never)
  await isSent
  stop()
  // le contexte suit le texte : $.prompt.submit n'en prend pas à part
  const p = sent.find(x => x.text.startsWith('explique'))!
  // un fichier mentionné part avec son emplacement seulement : Claude le lit lui-même
  expect(p.text).toContain('- a.ts, lignes 2-3')
  expect(p.text).not.toContain('l2\nl3')
  expect(p.text).not.toContain('Relit le code')
  // le prompt ouvre un tour dans l'historique, comme un prompt tapé
  expect((w.state.history as { prompt: string }[]).map(t => t.prompt)).toContain('explique @a.ts:2-3 avec /review')
  expect(w.state.queue).toEqual([])
})

test('« Soumettre la revue » envoie les points en attente sans prompt à écrire, avec leurs emplacements seulement', async ($, on) => {
  const w = workspace(on, { '/p/a.ts': 'l1\nl2\nl3\n' })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  const sent: string[] = []
  let arrived = () => {}
  const isSent = new Promise<void>(r => (arrived = r))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    arrived()
    return { text: e.text }
  })
  // une page est déjà ouverte : cette valeur tient jusqu'à ce que la mod réécrive `web`
  on('state.get', ($, e, next) =>
    (e as unknown as { key: string }).key === 'web' && !('web' in w.state)
      ? { value: { value: { shape: 'web-1', value: { port: 61077, token: 'cle' } }, version: 1 } }
      : next(e),
  )
  let stop = () => {}
  const alive = new Promise<void>(r => (stop = r))
  const say = (event: object) => ({ stream: 'stdout' as const, text: JSON.stringify({ event }) + '\n' })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":61077}\n' }
    yield say({ type: 'comment', path: '/p/a.ts', line: 2, endLine: 3, code: 'l2\nl3', text: 'renomme ça', id: 'c1' })
    yield say({ type: 'rejected', path: '/p/a.ts', line: 1, endLine: 1, code: 'code-rejeté' })
    yield say({ type: 'tests', text: 'Sortie de la commande « tests ». Journal complet : /logs/1-tests.log' })
    yield say({ type: 'sendReview' })
    await alive
    return { value: { code: 0, signal: null } }
  })

  await $.tool.call({ tool: `${T}command_save`, name: 'x', command: 'true' } as never)
  await isSent
  stop()
  const text = sent[0]!
  expect(text).toContain('a.ts, lignes 2-3\n   Commentaire : renomme ça')
  expect(text).toContain('a.ts, ligne 1 : bloc rejeté')
  expect(text).toContain('Journal complet : /logs/1-tests.log')
  // le code reste sur le disque : il ne part pas avec la revue
  expect(text).not.toContain('l2\nl3')
  expect(text).not.toContain('code-rejeté')
})

test('« ⤓ Terminal » met le prompt dans la zone de saisie du terminal sans l’envoyer ; envoyé de là, ses #i suivent', async ($, on) => {
  const w = workspace(on)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  on('prompt.read', () => ({ value: { text: 'déjà là', cursor: 7 } }))
  const filled: { text: string; mode?: string }[] = []
  let done = () => {}
  const isFilled = new Promise<void>(r => (done = r))
  on('prompt.fill', (_$, e) => (filled.push({ text: e.text, mode: e.mode }), done(), { isFilled: true, text: e.text, cursor: 0 }))
  const sent: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => (sent.push({ text: e.text, context: e.context ?? [] }), { text: e.text }))
  on('state.get', ($, e, next) =>
    (e as unknown as { key: string }).key === 'web' && !('web' in w.state)
      ? { value: { value: { shape: 'web-1', value: { port: 61077, token: 'cle' } }, version: 1 } }
      : next(e),
  )
  let stop = () => {}
  const alive = new Promise<void>(r => (stop = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":61077}\n' }
    yield { stream: 'stdout' as const, text: JSON.stringify({ event: { type: 'prompt.fill', text: 'regarde #i1' } }) + '\n' }
    await alive
    return { value: { code: 0, signal: null } }
  })

  await $.tool.call({ tool: `${T}idea_add`, text: 'Gérer le cache' } as never)
  await isFilled
  stop()
  // le brouillon du terminal est gardé, le prompt vient après ; rien n'est parti
  expect(filled).toEqual([{ text: ' regarde #i1', mode: 'append' }])
  expect(sent).toEqual([])

  // la personne l'envoie depuis le terminal : l'idée est jointe et passe « en cours »
  await $.prompt.submit({ text: 'déjà là regarde #i1' } as never)
  expect(sent[0]!.context.join('\n')).toContain('Idée #i1 de la boîte à idées : Gérer le cache')
  expect(w.project()!.ideas[0]!.status).toBe('doing')
})

test('la conversation part vers la page : prompts sans les rappels du système, réponses et outils', async ($, on) => {
  const w = workspace(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '<system-reminder>pour le modèle</system-reminder>Lis a.ts', toolUses: [] },
      { role: 'assistant', text: 'Je regarde.', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/p/a.ts' }, text: 'contenu' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'contenu', isError: false, result: null }] },
      { role: 'assistant', text: 'Voilà **fini**.', toolUses: [] },
      { role: 'user', text: '<command-name>/compact</command-name><command-args></command-args>', toolUses: [] },
    ] as never,
  }))
  const pg = page(on, w, [{ type: 'conversation', from: 0 }])
  const got = pg.next('conversation')
  await $.tool.call({ tool: `${T}command_save`, name: 'x', command: 'true' } as never)
  const all = await got
  pg.stop()
  expect(all.total).toBe(5)
  expect(all.items).toEqual([
    { i: 0, role: 'user', text: 'Lis a.ts' },
    { i: 1, role: 'assistant', text: 'Je regarde.', tools: [{ tool: 'Read', label: '📖 lit a.ts', out: 'contenu' }] },
    { i: 3, role: 'assistant', text: 'Voilà **fini**.' },
    { i: 4, role: 'user', text: '/compact', kind: 'command' },
  ])
})

test('Claude Status : contexte, limites, coût de la session et des sessions passées du projet', async ($, on) => {
  const dir = '/home/moi/.claude/projects/-p'
  const old = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Ancienne session', sessionId: 'old' }),
    JSON.stringify({ type: 'cost-state', sessionId: 'old', totalCostUSD: 1, startTime: 1, totalLinesAdded: 3, totalLinesRemoved: 1, totalDuration: 60_000, modelUsage: {} }),
    JSON.stringify({ type: 'cost-state', sessionId: 'old', totalCostUSD: 2.5, startTime: 1, totalLinesAdded: 5, totalLinesRemoved: 2, totalDuration: 120_000, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 2.5 } } }),
  ].join('\n') + '\n'
  const w = workspace(on, { [`${dir}/old.jsonl`]: old, [`${dir}/abc.jsonl`]: '{"type":"user"}\n' })
  w.mtimes.set(`${dir}/old.jsonl`, Date.now() - 1000)
  w.mtimes.set(`${dir}/abc.jsonl`, Date.now())
  on('session.usage', () => ({
    value: {
      startedAt: Date.now() - 600_000,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
      cost: { usd: 4 },
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.version', () => ({ value: { version: '2.1.322' } }))
  const pg = page(on, w, [{ type: 'dashboard' }])
  const got = pg.next('dashboard')
  await $.tool.call({ tool: `${T}command_save`, name: 'x', command: 'true' } as never)
  const d = (await got).data as Record<string, any>
  pg.stop()
  expect(d.session).toMatchObject({ id: 'abc', model: 'claude-opus-5-5', turns: 3, version: '2.1.322' })
  expect(d.context).toMatchObject({ tokens: 50_000, window: 200_000, percent: 25 })
  expect(d.limits[0]).toMatchObject({ kind: 'five_hour', percent: 40 })
  expect(d.current).toMatchObject({ id: 'abc', usd: 4, current: true })
  const past = d.project.sessions.find((x: { id: string }) => x.id === 'old')
  // la dernière ligne cost-state fait foi
  expect(past).toMatchObject({ title: 'Ancienne session', usd: 2.5, linesAdded: 5, wallMs: 120_000 })
  expect(past.models[0]).toMatchObject({ model: 'claude-sonnet-5-5', cacheRead: 300, usd: 2.5 })
  expect(d.project.total).toBe(6.5)
  expect(d.month).toMatchObject({ usd: 6.5, sessions: 2, projects: 1 })
})
