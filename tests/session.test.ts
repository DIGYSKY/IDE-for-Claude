import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]

/** Un fichier en mémoire que l'outil Write du test modifie. */
function oneFile(on: On) {
  let text = 'avant\n'
  on('session.cwd', () => ({ value: '/p' }))
  on('agent.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    text = (e as unknown as { content: string }).content
    return { result: { type: 'update', filePath: '/p/a.txt', content: text } }
  })
}

test('le panneau fermé par la personne ne se rouvre plus tout seul', async ($, on) => {
  oneFile(on)
  let opens = 0
  on('ui.open', () => (opens++, { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'un\n' })
  expect(opens).toBe(1)

  // « Quitter » ferme le panneau comme la croix : par ui.close
  const ui = await $.ui.mount({
    plugin: 'ide-for-claude', component: 'Pane', requestId: 'ide-for-claude', surface: 'terminal',
    props: { title: 'IDE for Claude', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  await ui.press({ key: 'quit' })
  await ui.unmount()
  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'deux\n' })
  expect(opens).toBe(1)
})

test('une nouvelle copie de la mod rebranche la page déjà ouverte (même port, même clé)', async ($, on) => {
  oneFile(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  // l'état de la session dit qu'une page est ouverte, mais cette copie de la mod n'a lancé aucun serveur :
  // la valeur d'avant tient jusqu'à ce que la mod réécrive `web`, ensuite l'état du kit répond
  let seeded = true
  const isWeb = (e: unknown) => (e as { key: string }).key === 'web'
  on('state.get', ($, e, next) =>
    seeded && isWeb(e) ? { value: { value: { shape: 'web-1', value: { port: 61077, token: 'cle-de-la-page' } }, version: 1 } } : next(e),
  )
  on('state.set', ($, e, next) => {
    if (isWeb(e)) seeded = false
    return next(e)
  })
  const fetched: string[] = []
  on('http.fetch', (_$, e) => (fetched.push(e.url), { value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  const spawned: string[][] = []
  // le faux serveur vit jusqu'à la fin du test, comme un vrai
  let stop = () => {}
  const alive = new Promise<void>(r => (stop = r))
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: '{"port":61077}\n' }
    await alive
    return { value: { code: 0, signal: null } }
  })

  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'un\n' })
  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'deux\n' })
  stop()

  // l'ancien serveur est arrêté, le nouveau reprend son port et sa clé, puis reçoit l'état
  // rien ne part vers la page avant que le nouveau serveur soit prêt
  expect(fetched[0]).toBe('http://127.0.0.1:61077/api/quit')
  expect(spawned.length).toBe(1)
  const argv = spawned[0]!
  expect(argv[argv.indexOf('--port') + 1]).toBe('61077')
  expect(argv[argv.indexOf('--token') + 1]).toBe('cle-de-la-page')
  expect(fetched).toContain('http://127.0.0.1:61077/api/push')
})
