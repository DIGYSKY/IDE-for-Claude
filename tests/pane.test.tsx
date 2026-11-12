import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'ide-for-claude', component: 'Pane', requestId: 'ide-for-claude',
  props: { title: 'IDE for Claude', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('le panneau vide montre la barre nano', async ($, on) => {
  on('session.cwd', () => ({ value: '/p' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'quit' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /IDE for Claude/ })).toBeTruthy()
    await ui.unmount()
  }
})
