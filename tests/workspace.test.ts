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
  on('fs.list', () => ({ value: [] }))
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
  return { disk, state, until, project }
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
