import { expect, test } from 'claude-code/testing'

import type { Change, Turn } from '../types'

/** Un petit projet en mémoire, hors git : le cas où la mod parcourt le dossier. */
type RunResult = { exitCode: number; stdout: string; stderr: string }
const notGit = (): RunResult => ({ exitCode: 128, stdout: '', stderr: 'pas un dépôt git' })

/** `run` répond aux commandes que la mod lance (git) ; par défaut, pas de dépôt. */
function project(on: Parameters<Parameters<typeof test>[1]>[1], run: (argv: readonly string[]) => RunResult = notGit) {
  const files = new Map<string, { text: string; mtimeMs: number }>([
    ['/p/a.txt', { text: 'un\ndeux\n', mtimeMs: 1 }],
    ['/p/src/c.txt', { text: 'à supprimer\n', mtimeMs: 1 }],
  ])
  let clock = 10
  const put = (path: string, text: string) => files.set(path, { text, mtimeMs: ++clock })
  // ce que la mod écrit dans son état, lu au passage
  const state: { history: Turn[]; changes: Change[] } = { history: [], changes: [] }
  on('state.set', ($, e, next) => {
    // l'atome écrit sa valeur dans une enveloppe { shape, value }
    const w = e as unknown as { plugin: string; key: string; value: { value: unknown } }
    if (w.plugin === 'ide-for-claude' && (w.key === 'history' || w.key === 'changes')) (state as Record<string, unknown>)[w.key] = w.value.value
    return next(e)
  })

  on('session.cwd', () => ({ value: '/p' }))
  on('process.run', (_$, e) => ({ value: run(e.argv) }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'general-purpose', description: 'renomme', status: 'running' as const }] }))
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('fs.list', (_$, e) => {
    const dir = e.path.replace(/\/$/, '')
    const seen = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir + '/')) continue
      const rest = p.slice(dir.length + 1)
      const name = rest.split('/')[0]!
      seen.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    return {
      value: [...seen].map(([name, kind]) => {
        const f = files.get(`${dir}/${name}`)
        return { name, kind, size: f ? f.text.length : 0, mtimeMs: f ? f.mtimeMs : 0, isLink: false }
      }),
    }
  })
  on('fs.stat', (_$, e) => {
    const f = files.get(e.path)
    if (!f) return { deny: 'ENOENT' }
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const f = files.get(e.path)
    if (!f) return { deny: 'ENOENT' }
    return { value: f.text }
  })
  on('fs.write', (_$, e) => (put(e.path, e.text), { value: undefined }))
  return { files, put, state }
}

test('suit les fichiers modifiés et créés par Bash, avec le sous-agent', async ($, on) => {
  const p = project(on)
  // « l'engine » : la commande Bash modifie a.txt, crée b.txt, supprime c.txt
  on('tool.call', { tool: 'Bash' }, () => {
    p.put('/p/a.txt', 'un\nDEUX\n')
    p.put('/p/b.txt', 'nouveau\n')
    p.files.delete('/p/src/c.txt')
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: "sed -i 's/deux/DEUX/' a.txt", agentId: 'a1' })

  const files = p.state.history.flatMap(t => t.files)
  const a = files.find(f => f.path === '/p/a.txt')
  const b = files.find(f => f.path === '/p/b.txt')
  expect(a?.before).toBe('un\ndeux\n')
  expect(a?.after).toBe('un\nDEUX\n')
  expect(a?.via).toBe('Bash')
  expect(a?.agent).toBe('general-purpose · renomme')
  expect(b?.before).toBe(null)
  expect(files.some(f => f.path === '/p/src/c.txt')).toBe(false)

  expect(p.state.changes.map(c => c.path).sort()).toEqual(['/p/a.txt', '/p/b.txt'])
})

test('un fichier de la revue supprimé par Bash en sort', async ($, on) => {
  const p = project(on)
  let step = 0
  on('tool.call', { tool: 'Bash' }, () => {
    if (step++ === 0) p.put('/p/src/c.txt', 'modifié\n')
    else p.files.delete('/p/src/c.txt')
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.tool.call({ tool: 'Bash', command: 'echo modifié > src/c.txt' })
  expect(p.state.changes.map(c => c.path)).toEqual(['/p/src/c.txt'])
  await $.tool.call({ tool: 'Bash', command: 'rm src/c.txt' })
  expect(p.state.changes).toEqual([])
  expect(p.state.changes.every(c => c.agent === 'general-purpose · renomme')).toBe(true)
})

test('une commande Bash qui ne touche rien ne laisse aucune trace', async ($, on) => {
  const p = project(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(p.state.history.flatMap(t => t.files)).toEqual([])
  expect(p.state.changes).toEqual([])
})

test('dans un dépôt git : le contenu d’avant vient de HEAD ou de la photo des fichiers déjà modifiés', async ($, on) => {
  let dirty = ' M d.txt\0'
  // le git du test : dépôt à /p, HEAD connaît a.txt, c.txt et d.txt
  const head: Record<string, string> = { 'a.txt': 'un\ndeux\n', 'src/c.txt': 'à supprimer\n', 'd.txt': 'origine\n' }
  const fail = { exitCode: 1, stdout: '', stderr: '' }
  const p = project(on, a => {
    if (a[0] !== 'git') return fail
    if (a.includes('rev-parse')) return { exitCode: 0, stdout: '/p\n', stderr: '' }
    if (a.includes('status')) return { exitCode: 0, stdout: dirty, stderr: '' }
    const show = a.find(x => x.startsWith('HEAD:'))
    const text = show ? head[show.slice(5)] : undefined
    return text === undefined ? { ...fail, exitCode: 128 } : { exitCode: 0, stdout: text, stderr: '' }
  })
  p.put('/p/d.txt', 'déjà modifié\n')
  on('tool.call', { tool: 'Bash' }, () => {
    p.put('/p/a.txt', 'un\nDEUX\n')
    p.put('/p/d.txt', 'déjà modifié, puis par Claude\n')
    p.put('/p/b.txt', 'nouveau\n')
    p.files.delete('/p/src/c.txt')
    dirty = ' M a.txt\0 M d.txt\0?? b.txt\0 D src/c.txt\0'
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm run fix' })

  const files = p.state.history.flatMap(t => t.files)
  const by = (path: string) => files.find(f => f.path === path)
  expect(by('/p/a.txt')?.before).toBe('un\ndeux\n')
  // d.txt était déjà modifié : l'avant est la photo, pas HEAD
  expect(by('/p/d.txt')?.before).toBe('déjà modifié\n')
  expect(by('/p/b.txt')?.before).toBe(null)
  expect(by('/p/src/c.txt')).toBe(undefined)
  expect(by('/p/a.txt')?.agent).toBe(undefined)
})
