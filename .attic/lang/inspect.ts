// 커서가 있는 자리를 읽는다: 이 토큰은 무엇이고, 지금 값은 뭐고, 어디서 정의·읽기·쓰기되나.
// 자동완성도 같은 해석을 쓴다.

import { NAME_KINDS, DECLS, lexLine, type Line, type Lexeme } from './tokenize'
import { Shaper, parseStmt, fmt, type Analysis, type Node, type World, type Env, type V } from './analyze'
import { parseExpr, type Expr } from './expr'

export type SymKind = 'model' | 'field' | 'interface' | 'port' | 'component' | 'system' | 'instance' | 'event' | 'var' | 'fail' | 'sample' | 'app'

export interface Sym { id: string; kind: SymKind; line: number; from: number; to: number; type?: string }

const isUpper = (s: string) => /^[A-Z]/.test(s)
const elem = (t?: string) => t?.replace(/^(List|Set)<(.+)>$/, '$2')

export const KINDS: Record<string, string> = {
  input: '들어오는 값', value: '들어오는 값', read: '들어오는 값',
  button: '들어오는 사건', watch: '들어오는 사건', route: '들어오는 사건 / 나가는 값',
  list: '나가는 값', text: '나가는 값', time: '나가는 값', notice: '나가는 값', image: '나가는 값',
  call: '나가는 사건',
  screen: '묶음', card: '묶음', row: '묶음', stack: '묶음',
}
export const STMT_DOC: Record<string, string> = {
  let: '이름 붙이기', when: '조건', else: '아니면', for: '반복',
  set: '값 바꾸기', clear: '비우기', create: '만들기', add: '넣기', remove: '빼기',
  delete: '지우기', emit: '바깥으로 보내기', fail: '실패: 전부 되돌림',
}
export const DECL_DOC: Record<string, string> = {
  model: '데이터의 모양', interface: '바깥과의 계약', system: '사건이 오면 바뀌는 것',
  component: '줄 묶음', sample: '이름 붙은 시나리오', app: '시작점',
}
const ATTRS: Record<string, string[]> = {
  list: ['of', 'sort'], input: ['placeholder'], button: ['disabled', 'visible'],
  text: ['bold', 'muted', 'visible'], card: ['visible'], row: ['visible'], call: ['body'],
}

// ── 심볼 표 ─────────────────────────────────────────────

export function symbols(a: Analysis): Map<string, Sym> {
  const out = new Map<string, Sym>()
  const put = (id: string, kind: SymKind, l: Lexeme | undefined, line: Line, type?: string) => {
    if (!l || out.has(id)) return
    out.set(id, { id, kind, line: line.no, from: l.from, to: l.to, type })
  }
  const walk = (n: Node, f: (n: Node) => void) => { f(n); n.children.forEach(c => walk(c, f)) }
  for (const root of a.roots) {
    const m = root.line.main
    const name = m[1]?.text ?? ''
    if (DECLS.has(root.head) && root.head !== 'use') put(name, root.head as SymKind, m[1], root.line)
    if (root.head === 'model') {
      for (const c of root.children) {
        const cm = c.line.main
        if (c.line.instance && c.line.assume?.[0]) put(c.line.assume[0].text, 'instance', c.line.assume[0], c.line, name)
        else if (cm[0] && c.head !== 'check')
          put(`${name}.${c.head}`, 'field', cm[0], c.line, cm[1]?.text === '=' ? undefined : cm.slice(1).map(l => l.text).join(''))
      }
    }
    if (root.head === 'interface') walk(root, n => {
      const nm = n.line.main
      if (NAME_KINDS.has(n.head) && nm[1]?.k === 'ident') put(`${name}.${nm[1].text}`, 'port', nm[1], n.line, n.head)
    })
    if (root.head === 'component') walk(root, n => {
      const nm = n.line.main
      if (n === root) return
      if (n.head === 'system') put(nm[1]?.text ?? '', 'system', nm[1], n.line)
      else if (NAME_KINDS.has(n.head) && nm[1]?.k === 'ident') put(`${name}.${nm[1].text}`, 'event', nm[1], n.line, n.head)
    })
    walk(root, n => {
      if (n.head === 'fail' && n.line.main[1]) put(n.line.main[1].text, 'fail', n.line.main[1], n.line)
    })
  }
  return out
}

/** 문자열 보간 `{…}` 안의 토큰들 */
export function innerLexes(lex: Lexeme): Lexeme[] {
  if (lex.k !== 'str') return []
  const out: Lexeme[] = []
  const re = /\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lex.text))) out.push(...lexLine(m[1], lex.from + m.index + 1))
  return out
}

/** 줄의 토큰 + 보간 안 토큰 */
const allLexes = (line: Line) => line.lex.flatMap(l => l.k === 'str' ? [l, ...innerLexes(l)] : [l])

// ── 줄의 문맥 ───────────────────────────────────────────

function nodeAt(a: Analysis, line: number): Node | undefined {
  let found: Node | undefined
  const walk = (n: Node) => { if (n.line.no === line) found = n; n.children.forEach(walk) }
  a.roots.forEach(walk)
  return found
}

function chain(n?: Node): Node[] {
  const out: Node[] = []
  for (let c = n; c; c = c.parent) out.unshift(c)
  return out
}

interface Ctx {
  root?: Node
  sys?: Node
  comp?: string        // component 이름
  subjT?: string       // `.` 의 타입
  scope: Map<string, string | undefined>
  varLine: Map<string, number>
}

/** inside: 줄 번호. 주면 마지막 노드의 자식 중 그 줄 앞까지 보이는 let 도 모은다 (새로 치는 줄용) */
function ctxOf(a: Analysis, w: World, nodes: Node[], inside?: number): Ctx {
  const root = nodes[0]
  const ctx: Ctx = { root, scope: new Map(), varLine: new Map() }
  if (root?.head === 'model') ctx.subjT = root.line.main[1]?.text
  if (root?.head === 'component') {
    ctx.comp = root.line.main[1]?.text
    ctx.subjT = w.components.get(ctx.comp ?? '')?.of
  }
  ctx.sys = nodes.find(n => n.head === 'system')
  if (!ctx.sys) return ctx
  // system 안: 이 줄 앞에서 보이는 let / for 를 모은다
  const target = nodes[nodes.length - 1]
  const sh = new Shaper(w)
  const visit = (ns: Node[]): boolean => {
    for (const n of ns) {
      if (n === target) {
        if (inside === undefined) return true
        const st = parseStmt(n)
        if (st.s === 'for') { ctx.scope.set(st.name, elem(sh.typeOf(st.e, ctx.scope, ctx.subjT))); ctx.varLine.set(st.name, n.line.no) }
        if (st.s === 'let') { ctx.scope.set(st.name, sh.typeOf(st.e, ctx.scope, ctx.subjT)); ctx.varLine.set(st.name, n.line.no) }
        for (const c of n.children) {
          if (c.line.no >= inside) break
          const cs = parseStmt(c)
          if (cs.s === 'let') { ctx.scope.set(cs.name, sh.typeOf(cs.e, ctx.scope, ctx.subjT)); ctx.varLine.set(cs.name, c.line.no) }
        }
        return true
      }
      const st = parseStmt(n)
      if (st.s === 'let') { ctx.scope.set(st.name, sh.typeOf(st.e, ctx.scope, ctx.subjT)); ctx.varLine.set(st.name, n.line.no) }
      if (nodes.includes(n)) {
        if (st.s === 'for') { ctx.scope.set(st.name, elem(sh.typeOf(st.e, ctx.scope, ctx.subjT))); ctx.varLine.set(st.name, n.line.no) }
        return visit(n.children)
      }
    }
    return false
  }
  if (target === ctx.sys && inside !== undefined) {
    for (const c of ctx.sys.children) {
      if (c.line.no >= inside) break
      const cs = parseStmt(c)
      if (cs.s === 'let') { ctx.scope.set(cs.name, sh.typeOf(cs.e, ctx.scope, ctx.subjT)); ctx.varLine.set(cs.name, c.line.no) }
    }
  } else visit(ctx.sys.children)
  return ctx
}

// ── 토큰 하나 해석 ──────────────────────────────────────

export interface Resolved { id?: string; kind?: SymKind | 'type' | 'keyword' | 'value'; type?: string; expr?: Expr; segFrom: number; segTo: number; text: string }

/** 토큰 안 오프셋(at)이 가리키는 경로 조각까지 해석 */
export function resolve(a: Analysis, syms: Map<string, Sym>, line: Line, lex: Lexeme, at: number, nodes?: Node[]): Resolved | undefined {
  const w = a.w
  if (!w) return
  nodes ??= chain(nodeAt(a, line.no))
  const ctx = ctxOf(a, w, nodes)
  const node = nodes[nodes.length - 1]

  // 경로를 조각으로 자른다
  const isSubj = lex.k === 'subj'
  const raw = isSubj ? lex.text.slice(1) : lex.text
  const parts = raw ? raw.split('.') : []
  let off = lex.from + (isSubj ? 1 : 0)
  const segs = parts.map(p => { const s = { text: p, from: off, to: off + p.length }; off += p.length + 1; return s })
  let idx = segs.findIndex(s => at >= s.from && at <= s.to)
  if (idx < 0) idx = isSubj && at <= lex.from ? -1 : segs.length - 1
  const pick = (id: string | undefined, kind: Resolved['kind'], from: number, to: number, type?: string, expr?: Expr): Resolved =>
    ({ id, kind, type, expr, segFrom: from, segTo: to, text: a.lines[line.no].text.slice(from - line.from, to - line.from) })

  if (lex.k !== 'ident' && lex.k !== 'path' && lex.k !== 'subj') return

  const m = line.main
  // 선언 줄의 이름, model 칸 이름, interface 포트 이름, 가정 인스턴스 이름
  if (m[1] === lex && DECLS.has(m[0]?.text ?? '')) return pick(lex.text, syms.get(lex.text)?.kind, lex.from, lex.to)
  if (ctx.root?.head === 'model' && m[0] === lex && node !== ctx.root && node?.head !== 'check') {
    const id = `${ctx.subjT}.${lex.text}`
    return pick(id, 'field', lex.from, lex.to, syms.get(id)?.type, { t: 'path', root: '.', segs: [lex.text], text: '.' + lex.text })
  }
  if (m[1] === lex && NAME_KINDS.has(m[0]?.text ?? '')) {
    const owner = ctx.root?.line.main[1]?.text
    const id = `${owner}.${lex.text}`
    return pick(id, syms.get(id)?.kind, lex.from, lex.to, m[0].text, ctx.root?.head === 'interface' ? { t: 'path', root: owner!, segs: [lex.text], text: id } : undefined)
  }
  if (m[1] === lex && (m[0]?.text === 'let' || m[0]?.text === 'for')) {
    return pick(`var:${lex.text}`, 'var', lex.from, lex.to, undefined, { t: 'path', root: lex.text, segs: [], text: lex.text })
  }
  if (line.instance && line.assume?.[0] === lex) return pick(lex.text, 'instance', lex.from, lex.to, w.names.get(lex.text)?.model, { t: 'path', root: lex.text, segs: [], text: lex.text })
  if (m[0] === lex && !isSubj && isUpper(lex.text) && w.components.has(lex.text)) return pick(lex.text, 'component', lex.from, lex.to)
  if (m[0] === lex && (STMT_DOC[lex.text] || KINDS[lex.text] || DECL_DOC[lex.text] || lex.text === 'check' || lex.text === 'open'))
    return pick(undefined, 'keyword', lex.from, lex.to, STMT_DOC[lex.text] ?? KINDS[lex.text] ?? DECL_DOC[lex.text])
  if (syms.get(lex.text)?.kind === 'fail') return pick(lex.text, 'fail', lex.from, lex.to)
  // component 안의 `on add`
  if (ctx.comp && m[0]?.text === 'system' && m.indexOf(lex) > 2 && !lex.text.includes('.')) {
    const id = `${ctx.comp}.${lex.text}`
    if (syms.has(id)) return pick(id, 'event', lex.from, lex.to)
  }

  // 일반 경로
  const sh = new Shaper(w)
  const rootText = isSubj ? '.' : parts[0]
  let type: string | undefined
  let id: string | undefined
  let start = 0
  if (isSubj) { type = ctx.subjT; if (idx < 0) return pick(undefined, 'value', lex.from, lex.from + 1, type, { t: 'path', root: '.', segs: [], text: '.' }) }
  else if (ctx.scope.has(rootText)) { type = ctx.scope.get(rootText); id = `var:${rootText}`; start = 1 }
  else if (w.names.has(rootText)) { type = w.names.get(rootText)!.model; id = rootText; start = 1 }
  else if (w.models.has(rootText)) { type = w.singles.has(rootText) ? rootText : `List<${rootText}>`; id = rootText; start = 1 }
  else if (isUpper(rootText)) {
    // interface · 바깥 값: Root.port 까지가 심볼
    const port = parts.length > 1 ? `${rootText}.${parts[1]}` : rootText
    const hit = syms.has(port) ? port : syms.has(rootText) ? rootText : undefined
    const upto = Math.max(idx, 0)
    const seg = segs[upto]
    const text = parts.slice(0, upto + 1).join('.')
    return pick(upto === 0 ? (syms.has(rootText) ? rootText : undefined) : hit, upto === 0 ? 'type' : syms.get(hit ?? '')?.kind ?? 'port', segs[0].from, seg.to,
      syms.get(hit ?? '')?.type, { t: 'path', root: rootText, segs: parts.slice(1, upto + 1), text })
  } else return pick(undefined, 'value', lex.from, lex.to)

  if (!isSubj && idx === 0) {
    if (id?.startsWith('var:')) return pick(id, 'var', segs[0].from, segs[0].to, type, { t: 'path', root: rootText, segs: [], text: rootText })
    return pick(id, syms.get(id ?? '')?.kind ?? 'type', segs[0].from, segs[0].to, type, w.models.has(rootText) && !w.singles.has(rootText) ? undefined : { t: 'path', root: rootText, segs: [], text: rootText })
  }
  for (let i = start; i <= idx; i++) {
    const owner = elem(type)
    id = `${owner}.${parts[i]}`
    type = owner ? w.models.get(owner)?.fields.get(parts[i])?.type : undefined
  }
  void sh
  const exprSegs = isSubj ? parts.slice(0, idx + 1) : parts.slice(1, idx + 1)
  return pick(id, 'field', segs[Math.max(idx, 0)].from, segs[Math.max(idx, 0)].to, type,
    { t: 'path', root: rootText, segs: exprSegs, text: (isSubj ? '.' : '') + parts.slice(0, idx + 1).join('.') })
}

// ── 커서 자리 ───────────────────────────────────────────

export interface Here {
  crumbs: { label: string; line: number }[]
  token?: Resolved
  def?: Sym
  value?: string
  values?: { label: string; value: string }[]
  scope: { name: string; value: string; type?: string }[]
  readers: string[]
  writers: string[]
  refs: { from: number; to: number; line: number }[]
  edits: { label: string; from: number; to: number; text: string }[]
}

export function here(a: Analysis, pos: number, syms = symbols(a)): Here {
  const out: Here = { crumbs: [], scope: [], readers: [], writers: [], refs: [], edits: [] }
  const w = a.w
  const line = a.lines.find(l => pos >= l.from && pos <= l.from + l.text.length)
  if (!w || !line) return out

  // 빈 줄이면 위쪽 가장 가까운 줄의 문맥을 쓴다
  let host = line
  for (let i = line.no; i >= 0 && a.lines[i].blank; i--) host = a.lines[i - 1] ?? host
  const nodes = chain(nodeAt(a, host.no))
  out.crumbs = nodes.map(n => ({ label: crumb(n), line: n.line.no }))
  const ctx = ctxOf(a, w, nodes)

  // 이 줄에서 보이는 값들: 주어와 변수
  const env = envFor(a, w, host.no, ctx)
  if (env.subj !== undefined) out.scope.push({ name: '.', value: fmt(env.subj), type: ctx.subjT })
  env.vars?.forEach((v, k) => out.scope.push({ name: k, value: fmt(v), type: ctx.scope.get(k) }))

  // 커서 아래 토큰
  const cands = allLexes(line).filter(l => pos >= l.from && pos <= l.to)
  const lex = cands.reverse().find(l => l.k === 'ident' || l.k === 'path' || l.k === 'subj') ?? cands[0]
  if (lex) {
    const r = resolve(a, syms, line, lex, pos, nodes)
    if (r) {
      out.token = r
      if (r.id) out.def = r.id.startsWith('var:')
        ? { id: r.id, kind: 'var', line: ctx.varLine.get(r.id.slice(4)) ?? line.no, from: a.lines[ctx.varLine.get(r.id.slice(4)) ?? line.no].from, to: a.lines[ctx.varLine.get(r.id.slice(4)) ?? line.no].from, type: r.type }
        : syms.get(r.id)
      if (r.expr) {
        // model 칸 줄이면 인스턴스마다
        if (ctx.root?.head === 'model' && r.kind === 'field' && r.expr.t === 'path' && r.expr.root === '.' && line.main[0]?.from === r.segFrom) {
          const model = ctx.subjT!
          const insts = w.singles.has(model) ? [w.singles.get(model)!] : w.instancesOf(model)
          out.values = insts.map(o => ({ label: o.name ?? o.model, value: fmt(w.eval(r.expr!, { subj: o })) }))
        } else {
          const v = w.eval(r.expr, env)
          out.value = fmt(v)
        }
      }
      if (r.id) {
        out.refs = references(a, syms, r.id)
        for (const sh of a.shapes) {
          const hit = (s: string) => s.replace(/^[~+⊕⊖\-] /, '') === r.id
          if (sh.reads.some(hit) || sh.on === r.id || sh.on.startsWith(r.id + ' ')) out.readers.push(sh.name)
          if (sh.writes.some(hit) || sh.emits.includes(r.id)) out.writers.push(sh.name)
        }
      }
    }
  }

  // 이 블록의 가정: 그 자리에서 고칠 수 있게
  if (nodes[0]) out.edits = assumptions(a, nodes[0])
  return out
}

function crumb(n: Node): string {
  const m = n.line.main
  if (n.line.instance) return `? ${n.line.assume?.[0]?.text ?? ''}`
  if (DECLS.has(n.head)) return `${n.head} ${m[1]?.text ?? ''}`
  if (NAME_KINDS.has(n.head) && m[1]) return `${n.head} ${m[1].text}`
  if (n.head === 'for' || n.head === 'let') return `${n.head} ${m[1]?.text ?? ''}`
  return n.head
}

function envFor(a: Analysis, w: World, no: number, ctx: Ctx): Env {
  const hit = a.envAt.get(no)
  if (hit) return hit
  // 가정 실행이 안 닿은 줄: system 이면 변수 없이, component 면 첫 인스턴스를 주어로
  if (ctx.subjT && ctx.root?.head === 'component') return { subj: w.instancesOf(ctx.subjT)[0], vars: new Map() }
  if (ctx.root?.head === 'model' && ctx.subjT) {
    const s = w.singles.get(ctx.subjT) ?? w.instancesOf(ctx.subjT)[0]
    return { subj: s, vars: new Map() }
  }
  return { vars: new Map() }
}

export function references(a: Analysis, syms: Map<string, Sym>, id: string) {
  const out: { from: number; to: number; line: number }[] = []
  for (const line of a.lines) {
    if (line.blank) continue
    const nodes = chain(nodeAt(a, line.no))
    for (const lex of allLexes(line)) {
      if (lex.k !== 'ident' && lex.k !== 'path' && lex.k !== 'subj') continue
      if (!lex.text.includes(id.split('.').pop()!.replace(/^var:/, ''))) continue
      // 조각마다 해석
      const pieces = lex.k === 'subj' ? lex.text.slice(1).split('.') : lex.text.split('.')
      let off = lex.from + (lex.k === 'subj' ? 1 : 0)
      for (const p of pieces) {
        const r = resolve(a, syms, line, lex, off, nodes)
        if (r?.id === id && !out.some(o => o.from === r.segFrom)) out.push({ from: r.segFrom, to: r.segTo, line: line.no })
        off += p.length + 1
      }
    }
  }
  return out
}

/** 블록 안의 `?` 값들. 라벨과 소스 범위 */
export function assumptions(a: Analysis, root: Node) {
  const out: { label: string; from: number; to: number; text: string }[] = []
  const doc = (from: number, to: number) => a.lines.map(l => l.text).join('\n').slice(from, to)
  const attrs = (ls: Lexeme[], prefix: string) => {
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].k === 'ident' && ls[i + 1]?.text === '=') {
        let j = i + 2
        let depth = 0
        const start = ls[j]
        // 값은 원자 하나: 토큰 하나 또는 괄호 묶음 하나
        while (j < ls.length) {
          const t = ls[j].text
          if (t === '(' || t === '[' || t === '{') depth++
          if (t === ')' || t === ']' || t === '}') depth--
          j++
          if (depth <= 0) break
        }
        const end = ls[Math.min(j, ls.length) - 1]
        if (start && end) out.push({ label: `${prefix}${ls[i].text}`, from: start.from, to: end.to, text: doc(start.from, end.to) })
        i = j - 1
      }
    }
  }
  const walk = (n: Node) => {
    const l = n.line
    if (l.assume?.length) {
      const m = l.main
      if (l.instance) attrs(l.assume.slice(1), `${l.assume[0].text}.`)
      else if (l.assume[0]?.k === 'path' && l.assume[1]?.text === '=') {
        const s = l.assume[2], e = l.assume[l.assume.length - 1]
        if (s) out.push({ label: l.assume[0].text, from: s.from, to: e.to, text: doc(s.from, e.to) })
      } else if (n.head === 'system') attrs(l.assume, 'payload.')
      else {
        const s = l.assume[0], e = l.assume[l.assume.length - 1]
        const label = NAME_KINDS.has(n.head) && m[1] ? m[1].text : n.head
        out.push({ label, from: s.from, to: e.to, text: doc(s.from, e.to) })
      }
    }
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

// ── 자동완성 ────────────────────────────────────────────

export interface Option { label: string; type: string; detail?: string; info?: string; boost?: number }

export function complete(a: Analysis, doc: string, pos: number, syms = symbols(a)): { from: number; options: Option[] } | null {
  const w = a.w
  if (!w) return null
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const before = doc.slice(lineStart, pos)
  const word = /[.\p{L}\p{N}_]*$/u.exec(before)![0]
  const head = before.slice(0, before.length - word.length)
  const indent = /^ */.exec(before)![0].length

  // 부모 줄 찾기 (지금 줄은 아직 개요에 없을 수 있다)
  const lineNo = doc.slice(0, lineStart).split('\n').length - 1
  let parentNo = -1
  for (let i = lineNo - 1; i >= 0; i--) {
    const l = a.lines[i]
    if (!l || l.blank) continue
    if (Math.floor(/^ */.exec(l.text)![0].length / 2) < Math.floor(indent / 2)) { parentNo = i; break }
  }
  const nodes = parentNo >= 0 ? chain(nodeAt(a, parentNo)) : []
  const ctx = ctxOf(a, w, nodes, lineNo)
  const rootHead = nodes[0]?.head

  const models = [...w.models.keys()]
  const env = a.envAt.get(lineNo) ?? envFor(a, w, parentNo, ctx)
  const opts: Option[] = []
  const fieldsOf = (type?: string, subj?: V) => {
    const def = w.models.get(elem(type) ?? '')
    if (!def) return
    for (const f of def.fields.values()) {
      let info: string | undefined
      if (subj !== undefined) info = fmt(w.field(subj, f.name))
      opts.push({ label: f.name, type: 'property', detail: f.derived ? '= 계산 칸' : f.type, info })
    }
  }

  // 1) 줄 맨 앞: 들어갈 수 있는 종류만
  if (head.trim() === '') {
    if (!nodes.length) Object.entries(DECL_DOC).forEach(([k, d]) => opts.push({ label: k, type: 'keyword', detail: d }))
    else if (ctx.sys) {
      Object.entries(STMT_DOC).forEach(([k, d]) => opts.push({ label: k, type: 'keyword', detail: d }))
      for (const c of w.components.values()) if (c.node.children.some(ch => STMT_DOC[ch.head])) opts.push({ label: c.name, type: 'class', detail: '문장 묶음' })
    } else if (rootHead === 'model') opts.push({ label: 'check', type: 'keyword', detail: '불변조건' })
    else if (rootHead === 'interface' || rootHead === 'component') {
      Object.entries(KINDS).forEach(([k, d]) => opts.push({ label: k, type: 'keyword', detail: d }))
      for (const c of w.components.values()) opts.push({ label: c.name, type: 'class', detail: c.of ? `of=${c.of}` : 'component' })
      if (rootHead === 'component') opts.push({ label: 'system', type: 'keyword', detail: DECL_DOC.system })
    } else if (rootHead === 'sample') ['given', 'expect'].forEach(k => opts.push({ label: k, type: 'keyword' }))
    else if (rootHead === 'app') opts.push({ label: 'open', type: 'keyword' })
    return { from: pos - word.length, options: opts }
  }

  // 2) of= 뒤: model
  if (/of=$/.test(head)) {
    models.forEach(m => opts.push({ label: m, type: 'class', detail: 'model' }))
    return { from: pos - word.length, options: opts }
  }

  // 3) on 뒤: 사건
  if (/\bon\s+$/.test(head)) {
    for (const s of syms.values()) {
      if (s.kind === 'port' && ['button', 'watch', 'route', 'input'].includes(s.type ?? '')) opts.push({ label: s.id, type: 'event', detail: s.type })
      if (s.kind === 'event' && ctx.comp && s.id.startsWith(ctx.comp + '.')) opts.push({ label: s.id.split('.')[1], type: 'event', detail: s.type, boost: 2 })
      if (s.kind === 'system') opts.push({ label: `${s.id}.fail`, type: 'event', detail: '실패했을 때' })
    }
    opts.push({ label: 'Clock.every', type: 'event', detail: '주기' })
    return { from: pos - word.length, options: opts }
  }

  // 4) 점 뒤: 그 타입의 칸
  if (word.includes('.')) {
    const prefix = word.slice(0, word.lastIndexOf('.'))
    const from = pos - (word.length - word.lastIndexOf('.') - 1)
    if (prefix === '' || prefix.startsWith('.')) {
      // .칸
      const p: Expr = parseExpr([{ k: 'subj', text: prefix + '', from: 0, to: prefix.length }])
      const sh = new Shaper(w)
      const t = prefix === '' ? ctx.subjT : sh.typeOf(p, ctx.scope, ctx.subjT)
      fieldsOf(t, prefix === '' ? env.subj : w.eval(p, env))
    } else {
      const root = prefix.split('.')[0]
      if (w.interfaces.has(root) || (!w.models.has(root) && !ctx.scope.has(root) && !w.names.has(root))) {
        for (const s of syms.values()) if ((s.kind === 'port') && s.id.startsWith(root + '.')) {
          const v = w.ports.get(s.id)
          opts.push({ label: s.id.slice(root.length + 1), type: 'property', detail: s.type, info: v !== undefined ? fmt(v) : undefined })
        }
        if (root === 'Clock') ['now', 'every'].forEach(k => opts.push({ label: k, type: 'property' }))
      } else {
        const p = parseExpr([{ k: 'path', text: prefix, from: 0, to: prefix.length }])
        const sh = new Shaper(w)
        fieldsOf(sh.typeOf(p, ctx.scope, ctx.subjT), w.eval(p, env))
      }
    }
    return { from, options: opts }
  }

  // 5) 그 밖: 속성 키, 변수, 이름들
  const kind = /^\s*(\w+)/.exec(before)?.[1] ?? ''
  for (const k of ATTRS[kind] ?? []) opts.push({ label: k + '=', type: 'property', detail: '속성', boost: 1 })
  ctx.scope.forEach((t, k) => opts.push({ label: k, type: 'variable', detail: t, info: env.vars?.has(k) ? fmt(env.vars.get(k)!) : undefined, boost: 3 }))
  for (const [n, o] of w.names) opts.push({ label: n, type: 'constant', detail: o.model, info: fmt(o) })
  for (const s of syms.values()) if (['model', 'interface', 'component'].includes(s.kind)) opts.push({ label: s.id, type: 'class', detail: s.kind })
  for (const k of ['and', 'or', 'not', 'in', 'to', 'from', 'find', 'where', 'sort', 'true', 'false']) opts.push({ label: k, type: 'keyword', boost: -1 })
  for (const f of ['sum', 'count', 'min', 'max']) opts.push({ label: f, type: 'function', detail: '목록 → 값', boost: -1 })
  return { from: pos - word.length, options: opts }
}
