import { expect, test } from 'claude-code/testing'
import { langOf, start, tokenize } from '../hooks/syntax'

test('colore du TypeScript', async () => {
  const toks = tokenize("const x = foo('a', 42) // note", langOf('a.ts'), start())
  const kinds = Object.fromEntries(toks.filter(t => t.kind).map(t => [t.text.trim(), t.kind]))
  expect(kinds['const']).toBe('kw')
  expect(kinds['foo']).toBe('fn')
  expect(kinds["'a'"]).toBe('str')
  expect(kinds['42']).toBe('num')
  expect(kinds['// note']).toBe('com')
})

test('colore du Markdown avec un bloc de code', async () => {
  const st = start()
  const md = langOf('x.md')
  expect(tokenize('# Titre', md, st)[0]?.kind).toBe('head')
  tokenize('```js', md, st)
  expect(tokenize('const a = 1', md, st)[0]?.kind).toBe('kw')
  tokenize('```', md, st)
  expect(tokenize('- Pomme', md, st)[1]?.kind).toBe('kw')
})
