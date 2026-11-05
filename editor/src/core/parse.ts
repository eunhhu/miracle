// 줄 → 나무. 들여쓰면 윗줄의 몸통.
import { splitLines, type SrcLine, type Tok } from './lex'
import { Parser, ParseError, parseCallRest, parsePat, parseType, parseValue, type Arg, type E, type Pat, type TypeRef } from './expr'

export type Kind =
  | 'use' | 'model' | 'field' | 'computed' | 'check' | 'decl' | 'fn' | 'catch'
  | 'for' | 'if' | 'else' | 'assign' | 'fail' | 'call' | 'expr' | 'bad'
  | 'case' | 'arm'

export interface Binder { name: string; from: number; to: number; type?: TypeRef }

export interface Node {
  kind: Kind
  line: SrcLine
  no: number
  indent: number
  children: Node[]
  parent?: Node
  name?: string
  nameFrom?: number
  type?: TypeRef
  params?: Binder[]
  binders?: Binder[]
  head?: E
  args?: Arg[]
  cond?: E
  value?: E
  target?: E
  op?: string
  use?: { path: string; items: string[] | '*'; alias?: string }
  catchNode?: Node
  /** fn 뒤의 catch 들 (catchNode = 첫 번째) */
  catches?: Node[]
  /** catch · match 갈래 모양 */
  pat?: Pat
  /** 이 줄 값이 match 면: 갈래 = children */
  match?: Extract<E, { t: 'match' }>
  elseNode?: Node
  ex?: E
  exArgs?: Arg[]
  expect?: E
  error?: { msg: string; from: number; to: number }
}

export interface Tree { lines: SrcLine[]; roots: Node[]; byLine: (Node | undefined)[] }

export function parse(doc: string): Tree {
  const lines = splitLines(doc)
  const byLine: (Node | undefined)[] = []
  const roots: Node[] = []
  const stack: Node[] = []
  for (const line of lines) {
    if (line.blank) continue
    while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop()
    const parent = stack[stack.length - 1]
    const node = parseLine(line, parent)
    node.parent = parent
    ;(parent ? parent.children : roots).push(node)
    byLine[line.no] = node
    stack.push(node)
  }
  attach(roots)
  return { lines, roots, byLine }
}

/** catch · else 를 앞 형제에 붙인다 */
function attach(list: Node[]) {
  const out: Node[] = []
  for (const n of list) {
    const prev = out[out.length - 1]
    if (n.kind === 'catch' && prev?.kind === 'fn') { (prev.catches ??= []).push(n); prev.catchNode ??= n; continue }
    if (n.kind === 'else' && prev && (prev.kind === 'if' || prev.kind === 'call')) {
      let p = prev
      while (p.elseNode) p = p.elseNode
      p.elseNode = n; continue
    }
    out.push(n)
  }
  list.splice(0, list.length, ...out)
  for (const n of list) {
    attach(n.children)
    for (const c of n.catches ?? []) attach(c.children)
    let e = n.elseNode
    while (e) { attach(e.children); e = e.elseNode }
    if (n.match) n.match.arms = n.children.filter(c => c.kind === 'arm').map(c => {
      const arm = { pat: c.pat!, body: c.value } as { pat: Pat; body?: E; node: Node }
      Object.defineProperty(arm, 'node', { value: c, enumerable: false })
      return arm
    })
  }
}

/** 칸 정의: model 몸통의 칸 줄, 또는 model X(a: T) · 경우 Circle(r: T) 의 괄호 */
export function fieldDefs(n: Node): { name: string; type?: TypeRef; value?: E; ex?: E; from: number }[] {
  if (n.params?.length) return n.params.map(p => ({ name: p.name, type: p.type, from: p.from }))
  return n.children.filter(c => c.kind === 'field').map(c => ({ name: c.name!, type: c.type, value: c.value, ex: c.ex, from: c.nameFrom ?? c.line.from }))
}

function parseParams(b: Tok[], open: number): { params: Binder[]; close: number } {
  let close = -1
  for (let i = open, d = 0; i < b.length; i++) {
    if (b[i].text === '(' || b[i].text === '[') d++
    if (b[i].text === ')' || b[i].text === ']') { d--; if (d === 0) { close = i; break } }
  }
  const params: Binder[] = []
  const inner = b.slice(open + 1, close < 0 ? undefined : close)
  let cur: Tok[] = []
  const flush = () => {
    if (!cur.length) return
    const nm = cur[0]
    params.push({ name: nm.text, from: nm.from, to: nm.to, type: parseType(cur.slice(2)) })
    cur = []
  }
  let d = 0
  for (const t of inner) {
    if (t.text === '(' || t.text === '[') d++
    if (t.text === ')' || t.text === ']') d--
    if (t.text === ',' && d === 0) flush(); else cur.push(t)
  }
  flush()
  return { params, close }
}

function lineError(node: Node, e: unknown) {
  const l = node.line
  if (e instanceof ParseError) node.error = { msg: e.message, from: e.at, to: e.at + 1 }
  else node.error = { msg: String((e as Error)?.message ?? e), from: l.from + l.indent, to: l.from + l.text.length }
}

function parseEx(node: Node) {
  const l = node.line
  if (l.ex && l.ex.length) {
    try {
      const p = new Parser(l.ex)
      const rest = parseCallRest(p)
      if (rest.args.length === 1 && !rest.args[0].key) node.ex = rest.args[0].value
      else node.exArgs = rest.args
    } catch (e) { lineError(node, e) }
  }
  if (l.expect && l.expect.length) {
    try { node.expect = parseValue(l.expect) } catch (e) { lineError(node, e) }
  }
}

const isPath = (toks: Tok[]) => {
  if (!toks.length || toks[0].k !== 'ident') return false
  try { const p = new Parser(toks); const e = p.expr(); return p.done() && (e.t === 'name' || e.t === 'member' || e.t === 'index') } catch { return false }
}

function topLevelOp(toks: Tok[], ops: string[]) {
  let d = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k === 'punct' && '([{'.includes(t.text)) d++
    else if (t.k === 'punct' && ')]}'.includes(t.text)) d--
    else if (d === 0 && t.k === 'op' && ops.includes(t.text)) return i
  }
  return -1
}

function parseLine0(line: SrcLine, parent?: Node): Node {
  const node: Node = { kind: 'expr', line, no: line.no, indent: line.indent, children: [] }
  const b = line.body
  const t0 = b[0]
  try {
    parseEx(node)
    if (!t0) { node.kind = 'expr'; return node }
    // match 갈래:  모양  값   (값 없으면 들여쓴 블록)
    if (parent?.match) {
      node.kind = 'arm'
      const { pat, rest } = parsePat(b)
      node.pat = pat
      if (rest < b.length) node.value = parseValue(b.slice(rest))
      return node
    }
    // model 안의 대문자 줄 = 경우
    if (parent?.kind === 'model' && t0.k === 'type') {
      node.kind = 'case'; node.name = t0.text; node.nameFrom = t0.from
      if (b[1]?.text === '(' && b[1].from === t0.to) node.params = parseParams(b, 1).params
      else node.params = []
      return node
    }
    // model 칸
    if (parent?.kind === 'model' || parent?.kind === 'case') {
      if (t0.k === 'kw' && t0.text === 'check') { node.kind = 'check'; node.value = parseValue(b.slice(1)); return node }
      if (t0.k === 'ident' && b[1]?.text === '=') {
        node.kind = 'computed'; node.name = t0.text; node.nameFrom = t0.from
        node.value = parseValue(b.slice(2)); return node
      }
      if (t0.k === 'ident') {
        // name: Text = 기본값   (예전 모양 name Text 도 읽는다)
        node.kind = 'field'; node.name = t0.text; node.nameFrom = t0.from
        const start = b[1]?.text === ':' ? 2 : 1
        const eq = topLevelOp(b, ['='])
        node.type = parseType(b.slice(start, eq < 0 ? undefined : eq))
        if (eq >= 0) node.value = parseValue(b.slice(eq + 1))
        if (!node.type) throw new ParseError('칸 이름 다음에 타입이 필요해 (예: name: Text)', t0.to)
        return node
      }
    }
    if (t0.k === 'kw') {
      switch (t0.text) {
        case 'use': {
          const text = line.text.slice(t0.to - line.from).replace(/\/\/.*$/, '').trim()
          const m = /^(\S+?)(?:\.\[(.*)\]|\.\*)?(?:\s+as\s+(\S+))?$/.exec(text)
          if (!m) throw new ParseError('use 경로가 이상해', t0.to)
          node.kind = 'use'
          node.use = { path: m[1], items: m[2] !== undefined ? m[2].split(',').map(s => s.trim()).filter(Boolean) : m[3] ? [] : '*', alias: m[3] }
          return node
        }
        case 'model': {
          node.kind = 'model'
          const n = b[1]
          if (!n || n.k !== 'type') throw new ParseError('model 이름은 대문자로 시작해 (예: model User)', n?.from ?? t0.to)
          node.name = n.text; node.nameFrom = n.from
          // model Status = "pending" | "paid"   → 고르기 · 별칭
          // model OutOfStock(product: Product)   → 한 줄 모델
          if (b[2]?.text === '(' && b[2].from === n.to) node.params = parseParams(b, 2).params
          if (b[2]?.text === '=') {
            node.type = parseType(b.slice(3))
            if (!node.type) throw new ParseError('= 다음에 타입 (예: model Status = "pending" | "paid")', b[2].to)
          }
          return node
        }
        case 'fn': {
          node.kind = 'fn'
          const n = b[1]
          if (!n || (n.k !== 'ident' && n.k !== 'type')) throw new ParseError('fn 다음엔 이름 (예: fn add())', t0.to)
          node.name = n.text; node.nameFrom = n.from
          node.params = []
          if (b[2]?.text === '(') {
            const pp = parseParams(b, 2)
            node.params = pp.params
            const close = pp.close
            // fn f(x: Int) -> Int = 식
            let k = close + 1
            if (close >= 0 && b[k]?.text === '->') {
              const eq = b.findIndex((t, i) => i > k && t.text === '=' && t.k === 'op')
              node.type = parseType(b.slice(k + 1, eq < 0 ? undefined : eq))
              k = eq < 0 ? b.length : eq
            }
            if (close >= 0 && b[k]?.text === '=') node.value = parseValue(b.slice(k + 1))
          }
          return node
        }
        case 'catch':
          node.kind = 'catch'
          // catch OutOfStock(p) · catch e
          if (b[1]?.k === 'type') node.pat = parsePat(b.slice(1)).pat
          else if (b[1]) node.binders = [{ name: b[1].text, from: b[1].from, to: b[1].to }]
          return node
        case 'for': {
          node.kind = 'for'
          const inAt = b.findIndex(t => t.k === 'kw' && t.text === 'in')
          if (inAt < 0) {
            // for 조건  (조건이 참인 동안)
            if (b.length < 2) throw new ParseError('for 이름 in 목록 · 또는 for 조건', t0.to)
            node.cond = parseValue(b.slice(1)); return node
          }
          node.binders = []
          for (const t of b.slice(1, inAt)) {
            if (t.text === ',') continue
            if (t.k !== 'ident') throw new ParseError('for 이름 in 목록 (번호도: for x, i in xs)', t.from)
            node.binders.push({ name: t.text, from: t.from, to: t.to })
          }
          if (!node.binders.length || node.binders.length > 2) throw new ParseError('for 이름 in 목록 (번호도: for x, i in xs)', t0.to)
          node.value = parseValue(b.slice(inAt + 1)); return node
        }
        case 'if': node.kind = 'if'; node.cond = parseValue(b.slice(1)); return node
        case 'else':
          node.kind = 'else'
          if (b[1]?.text === 'if') node.cond = parseValue(b.slice(2))
          return node
        case 'fail': node.kind = 'fail'; node.value = b.length > 1 ? parseValue(b.slice(1)) : undefined; return node
      }
    }
    // 선언: name: Type = 값
    if (t0.k === 'ident' && b[1]?.text === ':' && b[1].k === 'punct') {
      node.kind = 'decl'; node.name = t0.text; node.nameFrom = t0.from
      const eq = topLevelOp(b, ['='])
      node.type = parseType(b.slice(2, eq < 0 ? undefined : eq))
      if (eq >= 0) node.value = parseValue(b.slice(eq + 1))
      return node
    }
    // 바꾸기: path = 값
    const ai = topLevelOp(b, ['=', '+=', '-='])
    if (ai > 0 && isPath(b.slice(0, ai))) {
      node.kind = 'assign'; node.op = b[ai].text
      node.target = new Parser(b.slice(0, ai)).expr()
      node.value = parseValue(b.slice(ai + 1))
      return node
    }
    // 줄 머리 부르기
    if (t0.k === 'ident' || t0.k === 'type') {
      const n = b[1]
      const exprLike = n && ((n.from === t0.to && (n.text === '(' || n.text === '.' || n.text === '?.' || n.text === '[')) || (n.k === 'op' && n.text !== '...' ))
      if (!exprLike) {
        node.kind = 'call'
        node.head = t0.k === 'type' ? { t: 'type', name: t0.text, from: t0.from, to: t0.to } : { t: 'name', name: t0.text, from: t0.from, to: t0.to }
        const p = new Parser(b.slice(1))
        const rest = parseCallRest(p)
        node.args = rest.args; node.binders = rest.binders; node.cond = rest.cond
        return node
      }
    }
    node.kind = 'expr'
    node.value = parseValue(b)
  } catch (e) {
    node.kind = node.kind === 'expr' ? 'bad' : node.kind
    lineError(node, e)
  }
  return node
}

const parseLine = (line: SrcLine, parent?: Node): Node => {
  const n = parseLine0(line, parent)
  if (n.value?.t === 'match') n.match = n.value
  return n
}

/** 모든 노드 (catch · else 포함) */
export function* walk(list: Node[]): Generator<Node> {
  for (const n of list) {
    yield n
    yield* walk(n.children)
    for (const c of n.catches ?? []) { yield c; yield* walk(c.children) }
    let e = n.elseNode
    while (e) { yield e; yield* walk(e.children); e = e.elseNode }
  }
}

export function lastLineOf(n: Node): number {
  let last = n.no
  for (const c of walk([n])) last = Math.max(last, c.no)
  return last
}
