// Colorisation syntaxique légère, ligne par ligne, avec un état pour les
// commentaires sur plusieurs lignes et les blocs de code Markdown.

export type Kind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'head' | 'attr'
export type Tok = { text: string; kind?: Kind }
export type State = { inBlock: boolean; fence: Lang | null; inFence: boolean }

type Lang = {
  kw: Set<string>
  line: string[]
  block?: [string, string]
  quotes: string[]
  md?: true
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const JS = words(`break case catch class const continue debugger default delete do else export extends finally for
  from function if import in instanceof let new of return super switch this throw try typeof var void while with yield
  async await static get set true false null undefined as interface type enum implements private public protected
  readonly declare namespace abstract keyof satisfies`)
const PY = words(`and as assert async await break class continue def del elif else except False finally for from global
  if import in is lambda None nonlocal not or pass raise return True try while with yield self match case`)
const SH = words(`if then else elif fi for while until do done case esac function in return local export echo exit
  set unset source true false readonly shift`)
const C = words(`auto break case char const continue default do double else enum extern float for goto if int long
  register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false
  nullptr class public private protected virtual namespace using template typename new delete this include define
  package import func go defer chan map range type var interface struct select fallthrough fn let mut impl trait pub use
  mod match loop where self Self crate async await move ref dyn as final abstract extends implements throws throw try
  catch finally boolean byte null`)
const CSS = words(`important media import from to keyframes`)
const SQL = words(`select from where and or not insert into values update set delete create table drop alter join left
  right inner outer on as group by order having limit offset distinct union all null is in like between case when then
  else end primary key foreign references index`)

const LANGS: Record<string, Lang> = {
  js: { kw: JS, line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'] },
  py: { kw: PY, line: ['#'], quotes: ['"', "'"] },
  sh: { kw: SH, line: ['#'], quotes: ['"', "'"] },
  c: { kw: C, line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"] },
  css: { kw: CSS, line: [], block: ['/*', '*/'], quotes: ['"', "'"] },
  sql: { kw: SQL, line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'] },
  json: { kw: words('true false null'), line: [], quotes: ['"'] },
  yaml: { kw: words('true false null yes no'), line: ['#'], quotes: ['"', "'"] },
  html: { kw: new Set(), line: [], block: ['<!--', '-->'], quotes: ['"', "'"] },
  md: { kw: new Set(), line: [], quotes: [], md: true },
}

const EXT: Record<string, string> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', rb: 'py',
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', java: 'c', kt: 'c', go: 'c', rs: 'c', cs: 'c', swift: 'c', php: 'c',
  css: 'css', scss: 'css', less: 'css', sql: 'sql', json: 'json', jsonc: 'js',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  md: 'md', markdown: 'md',
}

export function langOf(path: string): Lang | null {
  const name = path.split('/').pop() ?? ''
  if (name === 'Dockerfile' || name === 'Makefile' || name.startsWith('.') && !name.includes('.', 1)) return LANGS.sh!
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const key = EXT[ext]
  return key ? LANGS[key]! : null
}

const fenceLang = (tag: string) => LANGS[EXT[tag.toLowerCase()] ?? tag.toLowerCase()] ?? null

export const start = (): State => ({ inBlock: false, fence: null, inFence: false })

/** Coupe une ligne en morceaux colorés ; `state` porte ce qui déborde sur la ligne suivante. */
export function tokenize(line: string, lang: Lang | null, state: State): Tok[] {
  if (!lang) return [{ text: line }]
  if (lang.md) return markdown(line, state)
  return code(line, lang, state)
}

function markdown(line: string, state: State): Tok[] {
  const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
  if (fence) {
    state.inFence = !state.inFence
    state.fence = state.inFence ? fenceLang(fence[2] ?? '') : null
    state.inBlock = false
    return [{ text: line, kind: 'com' }]
  }
  if (state.inFence) return state.fence ? code(line, state.fence, state) : [{ text: line, kind: 'str' }]
  if (/^\s{0,3}#{1,6}\s/.test(line)) return [{ text: line, kind: 'head' }]
  if (/^\s*>/.test(line)) return [{ text: line, kind: 'com' }]
  const out: Tok[] = []
  const list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line)
  let rest = line
  if (list) {
    out.push({ text: list[1]! }, { text: list[2]!, kind: 'kw' }, { text: list[3]! })
    rest = line.slice(list[0].length)
  }
  // `code`, **gras**, [lien](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    if (m.index > last) out.push({ text: rest.slice(last, m.index) })
    out.push({ text: m[0], kind: m[1] ? 'str' : m[2] ? 'kw' : 'fn' })
    last = m.index + m[0].length
  }
  if (last < rest.length) out.push({ text: rest.slice(last) })
  return out
}

function code(line: string, lang: Lang, state: State): Tok[] {
  const out: Tok[] = []
  const push = (text: string, kind?: Kind) => {
    if (!text) return
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind) prev.text += text
    else out.push({ text, kind })
  }
  let i = 0
  while (i < line.length) {
    if (state.inBlock && lang.block) {
      const end = line.indexOf(lang.block[1], i)
      if (end < 0) return push(line.slice(i), 'com'), out
      push(line.slice(i, end + lang.block[1].length), 'com')
      i = end + lang.block[1].length
      state.inBlock = false
      continue
    }
    const rest = line.slice(i)
    if (lang.line.some(p => rest.startsWith(p))) return push(rest, 'com'), out
    if (lang.block && rest.startsWith(lang.block[0])) {
      state.inBlock = true
      push(lang.block[0], 'com')
      i += lang.block[0].length
      continue
    }
    const ch = line[i]!
    if (lang.quotes.includes(ch)) {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      const text = line.slice(i, j + 1)
      // une chaîne suivie de « : » est une clé (JSON, YAML, objets)
      push(text, /^\s*:/.test(line.slice(j + 1)) ? 'attr' : 'str')
      i = j + 1
      continue
    }
    const num = /^(0x[\da-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/.exec(rest)
    if (num && !/[\w$]/.test(line[i - 1] ?? '')) {
      push(num[0], 'num')
      i += num[0].length
      continue
    }
    const id = /^[A-Za-z_$@][\w$-]*/.exec(rest)
    if (id) {
      const w = id[0]
      const after = line.slice(i + w.length)
      const kind: Kind | undefined = lang.kw.has(w)
        ? 'kw'
        : /^\s*\(/.test(after)
          ? 'fn'
          : /^\s*:(?!:)/.test(after) && (lang === LANGS.yaml || lang === LANGS.css)
            ? 'attr'
            : /^[A-Z]/.test(w)
              ? 'type'
              : undefined
      push(w, kind)
      i += w.length
      continue
    }
    push(ch)
    i++
  }
  return out
}

/** Coupe une suite de morceaux à `width` caractères, avec « … » si ça dépasse. */
export function cutToks(toks: Tok[], width: number): Tok[] {
  const out: Tok[] = []
  let room = width
  for (const t of toks) {
    if (room <= 0) break
    if (t.text.length <= room) {
      out.push(t)
      room -= t.text.length
    } else {
      out.push({ ...t, text: t.text.slice(0, Math.max(0, room - 1)) + '…' })
      room = 0
    }
  }
  return out
}
