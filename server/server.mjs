// Serveur local d’IDE for Claude : un par session Claude, sur 127.0.0.1 seulement,
// protégé par une clé aléatoire. Sans dépendance (Node 18+).
//
//   node server.mjs --root <projet> --token <clé> [--port <port>] [--name <nom>]
//
// Sortie standard, une ligne JSON par message, lue par la mod :
//   {"port": 4317}                 au démarrage
//   {"event": {"type": ...}}       une action faite dans la page (sauvegarde, commentaire, rejet...)
// La mod pousse l'état de la session sur /api/push et les messages d'activité sur /api/notify.

import http from 'node:http'
import fs from 'node:fs/promises'
import { watchFile, unwatchFile, readFileSync, realpathSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const ROOT = realpathSync(args.root ?? process.cwd())
const TOKEN = String(args.token ?? '')
const NAME = args.name ?? path.basename(ROOT)
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'dist', 'build', '.next', 'target'])
const MAX_BYTES = 2_000_000
const MAX_FILES = 20_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const page = () => readFileSync(path.join(HERE, 'index.html'), 'utf8')

if (TOKEN.length < 16) {
  console.error('clé manquante')
  process.exit(2)
}

// ---------- état poussé par la mod ----------
/** chemin absolu -> contenu avant les modifs de Claude du dernier prompt */
let changes = new Map()
/** chemin absolu -> le sous-agent qui l'a modifié */
let agents = new Map()
let history = []
let review = []
let accepted = []
let prefs = null
/** le reste de l'état de la session (idées, annotations, commandes, file, plan, barre d'état, réglages) */
let extra = {}
const EXTRA = ['project', 'queue', 'plan', 'busy', 'status', 'ide', 'editor', 'commands']

const clients = new Set()
const watched = new Set()
const emit = (event) => console.log(JSON.stringify({ event }))

const send = (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) res.write(data)
}

const watch = (file) => {
  if (watched.has(file)) return
  watched.add(file)
  watchFile(file, { interval: 600 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) send({ type: 'file', path: file })
  })
}

const isInside = (p) => p === ROOT || p.startsWith(ROOT + path.sep)
const rel = (p) => (isInside(p) ? path.relative(ROOT, p) : p)

const historyPaths = () => new Set(history.flatMap((t) => t.files.map((f) => f.path)))

/** Résout un chemin demandé par la page : dans le projet, ou un fichier touché par Claude. */
const allowed = async (p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null
  const abs = path.normalize(p)
  if (changes.has(abs) || historyPaths().has(abs)) return abs
  const real = await fs.realpath(abs).catch(() => null)
  if (real && isInside(real)) return abs
  const dir = await fs.realpath(path.dirname(abs)).catch(() => null)
  return !real && dir && isInside(dir) ? abs : null
}

const readText = async (file) => {
  const st = await fs.stat(file)
  if (st.size > MAX_BYTES) throw Object.assign(new Error('fichier trop gros'), { code: 413 })
  const text = await fs.readFile(file, 'utf8')
  if (text.includes('\u0000')) throw Object.assign(new Error('fichier binaire'), { code: 415 })
  return text
}

const body = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (c) => {
      size += c.length
      if (size > 60_000_000) reject(new Error('trop gros')), req.destroy()
      else parts.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
  })

const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// nombre approximatif de lignes ajoutées / retirées
const stats = (before, after) => {
  const count = (text) => {
    const m = new Map()
    for (const l of (text ?? '').split('\n')) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  let add = 0
  let del = 0
  for (const [l, n] of b) add += Math.max(0, n - (a.get(l) ?? 0))
  for (const [l, n] of a) del += Math.max(0, n - (b.get(l) ?? 0))
  if (before === null) del = 0
  return { add, del }
}

// le dernier prompt est le prompt courant : listé même tant que Claude n'a rien modifié
const historyMeta = () =>
  history
    .filter((t, i) => t.files.length > 0 || i === history.length - 1)
    .map((t) => ({
      id: t.id,
      prompt: t.prompt,
      at: t.at,
      current: t === history[history.length - 1],
      files: t.files.map((f) => ({
        path: f.path,
        rel: rel(f.path),
        isNew: f.before === null,
        inReview: changes.has(path.normalize(f.path)),
        agent: f.agent ?? null,
        via: f.via ?? null,
        ...stats(f.before, f.after),
      })),
    }))

// ---------- git ----------
const git = (argv) =>
  new Promise((resolve) =>
    execFile('git', argv, { cwd: ROOT, maxBuffer: 50_000_000 }, (err, stdout) => resolve(err ? null : stdout)),
  )
let gitTop
const gitTopLevel = async () => {
  if (gitTop === undefined) gitTop = ((await git(['rev-parse', '--show-toplevel'])) ?? '').trim() || null
  return gitTop
}
let gitCache = { at: 0, value: null }
const gitStatus = async () => {
  if (Date.now() - gitCache.at < 1500) return gitCache.value
  const top = await gitTopLevel()
  let value = { repo: false, status: {} }
  if (top) {
    const out = (await git(['-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? ''
    const parts = out.split('\0')
    const status = {}
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]
      if (entry.length < 4) continue
      const xy = entry.slice(0, 2)
      const p = path.join(top, entry.slice(3))
      if (xy[0] === 'R' || xy[0] === 'C') i++ // le chemin d'origine suit
      status[p] = xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('R') ? 'R' : 'M'
    }
    value = { repo: true, status }
  }
  gitCache = { at: Date.now(), value }
  return value
}
const gitShowHead = async (file) => {
  const top = await gitTopLevel()
  if (!top) return null
  const out = await git(['-C', top, 'show', `HEAD:${path.relative(top, file).split(path.sep).join('/')}`])
  return out ?? ''
}

// ---------- liste des fichiers et recherche ----------
let filesCache = { at: 0, value: [] }
const allFiles = async () => {
  if (Date.now() - filesCache.at < 5000) return filesCache.value
  const out = []
  const walk = async (dir) => {
    if (out.length >= MAX_FILES) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (HIDDEN.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await walk(ROOT)
  filesCache = { at: Date.now(), value: out }
  return out
}

const search = async (q, matchCase) => {
  const results = []
  const needle = matchCase ? q : q.toLowerCase()
  for (const file of await allFiles()) {
    if (results.length >= 400) break
    const st = await fs.stat(file).catch(() => null)
    if (!st || st.size > 1_000_000) continue
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text.includes('\u0000')) continue
    const hay = matchCase ? text : text.toLowerCase()
    if (!hay.includes(needle)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && results.length < 400; i++) {
      const l = matchCase ? lines[i] : lines[i].toLowerCase()
      const col = l.indexOf(needle)
      if (col >= 0) results.push({ path: file, rel: rel(file), line: i + 1, col: col + 1, text: lines[i].slice(0, 300) })
    }
  }
  return results
}

// ---------- exécuteur de commandes ----------
// Chaque lancement tourne dans le shell du système, à la racine du projet, sans limite de durée
// (un serveur de dev doit pouvoir tourner) ; sa sortie part en direct dans la page.
const MAX_OUT = 1_000_000
const MAX_RUNS = 30
/** id -> { id, name, command, started, ended, code, out, child } */
const runs = new Map()
let runSeq = 0
const runInfo = (r, withOut = false) => ({
  id: r.id,
  name: r.name,
  command: r.command,
  started: r.started,
  ended: r.ended,
  code: r.code,
  stopped: !!r.stopped,
  running: !r.ended,
  ...(withOut ? { out: r.out } : { tail: r.out.slice(-2000) }),
})
const runsState = () => [...runs.values()].map((r) => runInfo(r))
// les couleurs des terminaux n'ont rien à faire dans la page
const stripAnsi = (t) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const exists = (f) => fs.access(path.join(ROOT, f)).then(() => true, () => false)
/** des commandes à proposer : scripts de package.json, tests détectés, cibles du Makefile */
async function suggestions() {
  const out = []
  // un package.json abîmé ne doit pas casser l'onglet : pas de suggestions de scripts, c'est tout
  const pkg = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8').then((t) => JSON.parse(t)).catch(() => null)
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const pm = (await exists('pnpm-lock.yaml')) ? 'pnpm' : (await exists('yarn.lock')) ? 'yarn' : (await exists('bun.lockb')) || (await exists('bun.lock')) ? 'bun' : 'npm'
    for (const name of Object.keys(pkg.scripts)) {
      if (name === 'test' && /no test specified/.test(pkg.scripts.test)) continue
      out.push({ name, command: pm === 'npm' && (name === 'test' || name === 'start') ? `npm ${name}` : `${pm} run ${name}` })
    }
  }
  if ((await exists('.claude-plugin/plugin.json')) && (await exists('tests'))) out.push({ name: 'tests de la mod', command: 'claude plugin test .' })
  if (await exists('Cargo.toml')) out.push({ name: 'cargo test', command: 'cargo test' }, { name: 'cargo run', command: 'cargo run' })
  if (await exists('go.mod')) out.push({ name: 'go test', command: 'go test ./...' })
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('setup.py'))) out.push({ name: 'pytest', command: 'pytest' })
  const mk = await fs.readFile(path.join(ROOT, 'Makefile'), 'utf8').catch(() => '')
  for (const m of mk.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) out.push({ name: `make ${m[1]}`, command: `make ${m[1]}` })
  return out.slice(0, 40)
}

function startRun(command, name) {
  // on ne garde que les derniers lancements terminés
  const done = [...runs.values()].filter((r) => r.ended)
  while (runs.size >= MAX_RUNS && done.length) runs.delete(done.shift().id)
  const r = { id: String(++runSeq), name: name || command, command, started: Date.now(), ended: 0, code: null, out: '', child: null }
  runs.set(r.id, r)
  send({ type: 'run', phase: 'start', run: runInfo(r) })
  const child = spawn(command, {
    cwd: ROOT,
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  r.child = child
  const onData = (buf) => {
    const text = stripAnsi(buf.toString('utf8'))
    r.out = (r.out + text).slice(-MAX_OUT)
    send({ type: 'run', phase: 'out', id: r.id, text })
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const done2 = (code) => {
    if (r.ended) return
    Object.assign(r, { ended: Date.now(), code, child: null })
    send({ type: 'run', phase: 'end', run: runInfo(r) })
  }
  child.on('error', (e) => {
    onData(Buffer.from(`\n${e.message}\n`))
    done2(-1)
  })
  child.on('close', (code, signal) => done2(code ?? (signal ? -1 : 0)))
  return r
}

function stopRun(r) {
  const child = r?.child
  if (!child) return
  r.stopped = true
  try {
    // tout le groupe : npm lance souvent d'autres processus sous lui
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}
const stopAll = () => {
  for (const r of runs.values()) stopRun(r)
}

// ---------- serveur ----------
let PORT = 0

const server = http.createServer(async (req, res) => {
  try {
    // contre le « DNS rebinding » : seules ces adresses sont acceptées
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return json(res, 403, { error: 'hôte refusé' })
    const url = new URL(req.url ?? '/', `http://${host}`)
    const token = url.searchParams.get('t') ?? req.headers['x-token']
    if (token !== TOKEN) return json(res, 403, { error: 'clé invalide' })
    const q = (k) => url.searchParams.get(k)
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end(page())
    }

    if (route === 'GET /api/state')
      return json(res, 200, {
        root: ROOT,
        name: NAME,
        sep: path.sep,
        changes: [...changes.keys()].map((p) => ({ path: p, rel: rel(p), agent: agents.get(p) ?? null })),
        history: historyMeta(),
        review,
        accepted,
        prefs,
        ...extra,
        runs: runsState(),
      })

    if (route === 'GET /api/tree') {
      const dir = await allowed(q('dir') ?? ROOT)
      if (!dir) return json(res, 403, { error: 'hors du projet' })
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const keys = [...changes.keys()]
      const list = entries
        .filter((e) => !HIDDEN.has(e.name))
        .map((e) => {
          const p = path.join(dir, e.name)
          const isDir = e.isDirectory()
          return {
            name: e.name,
            path: p,
            kind: isDir ? 'dir' : 'file',
            changed: !isDir && changes.has(p),
            hasChanged: isDir && keys.some((k) => k.startsWith(p + path.sep)),
          }
        })
        .sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
      return json(res, 200, { entries: list })
    }

    if (route === 'GET /api/file') {
      const file = await allowed(q('path'))
      if (!file) return json(res, 403, { error: 'hors du projet' })
      const text = await readText(file).catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)))
      watch(file)
      const before = q('ref') === 'HEAD' ? await gitShowHead(file) : changes.has(file) ? changes.get(file) : null
      return json(res, 200, { path: file, text, before })
    }

    // le diff d'un prompt de l'historique, ou de toute la session
    if (route === 'GET /api/turn') {
      const file = path.normalize(q('path') ?? '')
      if (q('id') === 'session') {
        const first = history.flatMap((t) => t.files).find((f) => f.path === file)
        if (!first) return json(res, 404, { error: 'introuvable' })
        const now = await readText(file).catch(() => '')
        return json(res, 200, { before: first.before ?? '', after: now })
      }
      const turn = history.find((t) => t.id === Number(q('id')))
      const f = turn?.files.find((x) => x.path === file)
      if (!f) return json(res, 404, { error: 'introuvable' })
      return json(res, 200, { before: f.before ?? '', after: f.after })
    }

    if (route === 'GET /api/files') return json(res, 200, { files: (await allFiles()).map((p) => ({ path: p, rel: rel(p) })) })

    if (route === 'GET /api/search') {
      const text = q('q') ?? ''
      if (text.length < 2) return json(res, 200, { results: [] })
      return json(res, 200, { results: await search(text, q('case') === '1') })
    }

    if (route === 'GET /api/git') return json(res, 200, await gitStatus())

    if (route === 'POST /api/save') {
      const { path: p, text, base, force, kind, info } = await body(req)
      const file = await allowed(p)
      if (!file) return json(res, 403, { error: 'refusé' })
      const now = await readText(file).catch(() => null)
      if (!force && now !== null && typeof base === 'string' && now !== base)
        return json(res, 409, { error: 'modifié sur le disque', current: now })
      if (kind === 'delete') await fs.rm(file, { force: true })
      else if (typeof text === 'string') await fs.writeFile(file, text, 'utf8')
      else return json(res, 400, { error: 'texte manquant' })
      gitCache.at = 0
      filesCache.at = 0
      if (kind === 'reject') emit({ type: 'rejected', path: file, ...(info ?? {}) })
      else if (kind === 'delete') emit({ type: 'rejected', path: file, file: true, ...(info ?? {}) })
      else {
        changes.delete(file)
        emit({ type: 'saved', path: file })
      }
      send({ type: 'state' })
      return json(res, 200, { ok: true })
    }

    // une action de la page pour la mod : commentaire, acceptation, préférences...
    if (route === 'POST /api/event') {
      const ev = await body(req)
      if (ev.type === 'prefs') prefs = ev.prefs ?? null
      emit(ev)
      return json(res, 200, { ok: true })
    }

    // la mod pousse l'état de la session
    if (route === 'POST /api/push') {
      const s = await body(req)
      const list = Array.isArray(s.changes) ? s.changes : []
      changes = new Map(list.map((c) => [path.normalize(c.path), String(c.before ?? '')]))
      agents = new Map(list.filter((c) => c.agent).map((c) => [path.normalize(c.path), String(c.agent)]))
      history = Array.isArray(s.history) ? s.history : history
      review = Array.isArray(s.review) ? s.review : review
      accepted = Array.isArray(s.accepted) ? s.accepted : accepted
      if (s.prefs !== undefined) prefs = s.prefs
      for (const k of EXTRA) if (s[k] !== undefined) extra[k] = s[k]
      for (const p of changes.keys()) watch(p)
      send({ type: 'state' })
      return json(res, 200, { ok: true })
    }

    // la mod parle à la page : activité, fin de tour, toast, conflit de restauration
    if (route === 'POST /api/notify') {
      send(await body(req))
      return json(res, 200, { ok: true })
    }

    // une nouvelle copie de la mod reprend la session : elle arrête ce serveur pour reprendre son port
    if (route === 'POST /api/quit') {
      json(res, 200, { ok: true })
      stopAll()
      server.close()
      for (const r of clients) r.destroy()
      setTimeout(() => process.exit(0), 50)
      return
    }

    if (route === 'GET /api/runs') return json(res, 200, { runs: runsState(), suggestions: await suggestions() })

    if (route === 'GET /api/run') {
      const r = runs.get(q('id') ?? '')
      return r ? json(res, 200, runInfo(r, true)) : json(res, 404, { error: 'introuvable' })
    }

    if (route === 'POST /api/run') {
      const { command, name } = await body(req)
      if (typeof command !== 'string' || !command.trim()) return json(res, 400, { error: 'commande vide' })
      const r = startRun(command.trim(), typeof name === 'string' ? name.trim() : '')
      return json(res, 200, runInfo(r))
    }

    if (route === 'POST /api/run/stop') {
      const { id } = await body(req)
      stopRun(runs.get(String(id)))
      return json(res, 200, { ok: true })
    }

    if (route === 'POST /api/run/forget') {
      const { id } = await body(req)
      const r = runs.get(String(id))
      if (r && !r.ended) return json(res, 409, { error: 'encore en cours' })
      runs.delete(String(id))
      send({ type: 'run', phase: 'forget', id: String(id) })
      return json(res, 200, { ok: true })
    }

    if (route === 'GET /events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': ok\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    json(res, 404, { error: 'introuvable' })
  } catch (e) {
    json(res, e?.code === 413 || e?.code === 415 ? e.code : 500, { error: String(e?.message ?? e) })
  }
})

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 20_000).unref()

// s'arrête si la session Claude qui l'a lancé disparaît
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    stopAll()
    process.exit(0)
  }
}, 5_000).unref()

const listen = (port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })

// le port demandé (celui de la page déjà ouverte) peut être encore tenu un instant par
// l'ancien serveur qui s'arrête : on réessaie quelques secondes avant d'en prendre un autre
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function listenPreferred(port) {
  for (let i = 0; i < 20; i++) {
    try {
      return await listen(port)
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') break
      await wait(150)
    }
  }
  return listen(0)
}
PORT = await (Number(args.port) ? listenPreferred(Number(args.port)) : listen(0))
console.log(JSON.stringify({ port: PORT }))

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(sig, () => {
    stopAll()
    for (const p of watched) unwatchFile(p)
    process.exit(0)
  })
