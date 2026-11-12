import { expect, test } from 'claude-code/testing'

import type { Turn } from '../types'

type On = Parameters<Parameters<typeof test>[1]>[1]
const FILE = '/home/moi/.claude/plugins/data/ide-for-claude/sessions/abc-123.json'

/** Une session « abc-123 » dans /p, un disque en mémoire. */
function session(on: On, disk: Map<string, string>, id: () => string = () => 'abc-123') {
  on('session.cwd', () => ({ value: '/p' }))
  on('session.id', () => ({ value: id() }))
  on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'HOME' ? '/home/moi' : undefined }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: disk.has(e.path) }))
  on('fs.stat', (_$, e) => (disk.has(e.path) ? { value: { kind: 'file' as const, size: disk.get(e.path)!.length, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_$, e) => (disk.has(e.path) ? { value: disk.get(e.path)! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => (disk.set(e.path, e.text), { value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }))
}

test("l'historique de la session est écrit sur le disque à la fin du tour", async ($, on) => {
  const disk = new Map([['/p/a.txt', 'avant\n']])
  session(on, disk)
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    disk.set('/p/a.txt', (e as unknown as { content: string }).content)
    return { result: { type: 'update', filePath: '/p/a.txt', content: '' } }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'après\n' })
  await $.turn.complete({ answer: '' } as never)

  const saved = JSON.parse(disk.get(FILE) ?? 'null')
  expect(saved?.cwd).toBe('/p')
  const f = (saved?.history as Turn[]).flatMap(t => t.files)[0]
  expect(f?.before).toBe('avant\n')
  expect(f?.after).toBe('après\n')
})

test('une session reprise retrouve son historique', async ($, on) => {
  const history: Turn[] = [{ id: 1, prompt: 'renomme', at: 1, files: [{ path: '/p/a.txt', before: 'avant\n', after: 'après\n' }] }]
  const disk = new Map([
    ['/p/a.txt', 'après\n'],
    [FILE, JSON.stringify({ v: 1, cwd: '/p', savedAt: 1, history, changes: [{ path: '/p/a.txt', before: 'avant\n', stale: false }], review: [], accepted: [] })],
  ])
  session(on, disk)
  const written: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    written[w.key] = w.value.value
    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  expect(written.history).toEqual(history)
  expect((written.changes as { path: string }[]).map(c => c.path)).toEqual(['/p/a.txt'])
})

test('reprise depuis la liste : l’id change sans session.start, l’historique est relu et jamais écrasé', async ($, on) => {
  const history: Turn[] = [{ id: 1, prompt: 'fait un test', at: 1, files: [{ path: '/p/a.txt', before: null, after: 'un\n' }] }]
  const saved = JSON.stringify({ v: 1, cwd: '/p', savedAt: 1, history, changes: [], review: [], accepted: [] })
  const disk = new Map([['/p/a.txt', 'un\n'], [FILE, saved]])
  // la session démarre sous un nouvel id, puis /resume la bascule sur abc-123
  let id = 'nouvelle-session'
  session(on, disk, () => id)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: (e as unknown as { sessionId: string }).sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const written: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    const w = e as unknown as { key: string; value: { value: unknown } }
    written[w.key] = w.value.value
    return next(e)
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'resume', sessionId: 'nouvelle-session', resume: {} } as never)
  id = 'abc-123'
  await $.prompt.submit({ text: 'le prompt est resté ?' } as never)

  expect((written.history as Turn[]).map(t => t.prompt)).toEqual(['fait un test', 'le prompt est resté ?'])
  // le fichier garde l'historique
  expect((JSON.parse(disk.get(FILE)!).history as Turn[]).map(t => t.prompt)).toEqual(['fait un test'])
  expect(disk.has('/home/moi/.claude/plugins/data/ide-for-claude/sessions/nouvelle-session.json')).toBe(false)
})
