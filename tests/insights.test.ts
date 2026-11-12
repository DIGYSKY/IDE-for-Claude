import { expect, test } from 'claude-code/testing'
import { sessionCostOf, userText } from '../hooks/insights'

test('la fin d’un sous-agent en arrière-plan devient une ligne, pas du XML', async () => {
  const raw =
    '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Résumer app.js" finished</summary>\n<result>…</result>\n</task-notification>'
  expect(userText(raw)).toEqual({ text: '🤖 Agent "Résumer app.js" finished', kind: 'notice' })
})

test('une session sans titre se reconnaît à son premier prompt (pas une commande ni un rappel)', async () => {
  const text = [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>…</local-command-caveat>' } }),
    JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Corrige le bug du panier' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'Autre chose' } }),
  ].join('\n')
  const info = sessionCostOf('s1', text, 1)
  expect(info.prompt).toBe('Corrige le bug du panier')
  expect(info.title).toBeUndefined()
})

test('le début coupé d’un gros fichier n’empêche pas de lire le coût et le titre', async () => {
  // ce que renvoie la lecture partielle : un début tronqué, puis les lignes de coût et de titre
  const text = [
    '{"type":"user","message":{"content":"tronq',
    JSON.stringify({ type: 'ai-title', aiTitle: 'Longue session' }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 57.9, startTime: 5, modelUsage: {} }),
  ].join('\n')
  const info = sessionCostOf('big', text, 10)
  expect(info.usd).toBe(57.9)
  expect(info.title).toBe('Longue session')
})
