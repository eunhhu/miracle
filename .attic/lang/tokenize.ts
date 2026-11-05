// Miracle 토크나이저: 한 줄 = 하나. 줄 단위로 끊고, 들여쓰기로 문맥을 잡는다.

export type LexKind =
  | 'ident' | 'path' | 'subj' | 'str' | 'bytes' | 'time' | 'num'
  | 'op' | 'punct' | 'assume' | 'expect' | 'comment'

export interface Lexeme {
  k: LexKind
  text: string
  from: number // 줄 시작 기준 오프셋
  to: number
}

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*/u
const OPS = ['==', '!=', '<=', '>=', '??', '->', '<', '>', '+', '-', '*', '/', '%', '=', '|']
const PUNCT = '()[]{},:'

export function lexLine(src: string, base = 0): Lexeme[] {
  const out: Lexeme[] = []
  let i = 0
  const push = (k: LexKind, from: number, to: number) =>
    out.push({ k, text: src.slice(from, to), from: from + base, to: to + base })

  while (i < src.length) {
    const c = src[i]
    const rest = src.slice(i)
    if (c === ' ' || c === '\t') { i++; continue }

    if (rest.startsWith('//')) { push('comment', i, src.length); break }

    // 가정 / 기대 표식: 뒤가 공백·줄끝일 때만 (??, != 는 연산자)
    if (c === '?' && src[i + 1] !== '?') { push('assume', i, i + 1); i++; continue }
    if (c === '!' && src[i + 1] !== '=') { push('expect', i, i + 1); i++; continue }

    if (c === '"' || (c === 'b' && src[i + 1] === '"')) {
      const start = i
      i += c === 'b' ? 2 : 1
      let depth = 0
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth = Math.max(0, depth - 1)
        else if (src[i] === '"' && depth === 0) { i++; break }
        i++
      }
      push(c === 'b' ? 'bytes' : 'str', start, i)
      continue
    }

    const time = /^\d{1,2}:\d{2}(?![\d])/.exec(rest)
    if (time) { push('time', i, i + time[0].length); i += time[0].length; continue }

    const num = /^\d+(\.\d+)?([a-z%]+)?/.exec(rest)
    if (num) { push('num', i, i + num[0].length); i += num[0].length; continue }

    // .path 또는 . (현재 주어)
    if (c === '.') {
      const prev = out[out.length - 1]
      const glued = prev && prev.to === i + base && (prev.k === 'path' || prev.k === 'ident' || prev.k === 'subj')
      if (!glued) {
        const m = /^\.([\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*)?/u.exec(rest)!
        push('subj', i, i + m[0].length)
        i += m[0].length
        continue
      }
    }

    const id = IDENT.exec(rest)
    if (id) {
      let j = i + id[0].length
      let k: LexKind = 'ident'
      while (src[j] === '.' && IDENT.test(src.slice(j + 1))) {
        j += 1 + IDENT.exec(src.slice(j + 1))![0].length
        k = 'path'
      }
      push(k, i, j)
      i = j
      continue
    }

    const op = OPS.find(o => rest.startsWith(o))
    if (op) { push('op', i, i + op.length); i += op.length; continue }

    if (PUNCT.includes(c)) { push('punct', i, i + 1); i++; continue }

    // 모르는 글자는 하나씩 넘긴다 (에디터에서 타이핑 중인 상태를 견뎌야 한다)
    push('punct', i, i + 1)
    i++
  }
  return out
}

export interface Line {
  no: number        // 0부터
  from: number      // 문서 기준 오프셋
  text: string
  indent: number    // 단계 (두 칸 = 1)
  lex: Lexeme[]     // 문서 기준 오프셋
  main: Lexeme[]    // 가정·기대·주석을 뺀 본문
  assume?: Lexeme[] // `?` 뒤
  expect?: Lexeme[] // `!` 뒤
  assumeAt?: number // `?` 위치
  expectAt?: number
  instance: boolean // 줄 맨 앞이 `?` → 가정한 인스턴스
  blank: boolean
}

export function splitLines(doc: string): Line[] {
  const lines: Line[] = []
  let from = 0
  doc.split('\n').forEach((text, no) => {
    const spaces = /^ */.exec(text)![0].length
    const lex = lexLine(text, from)
    const body = lex.filter(l => l.k !== 'comment')
    const line: Line = {
      no, from, text, indent: Math.floor(spaces / 2), lex,
      main: [], instance: false, blank: body.length === 0,
    }
    let mode: 'main' | 'assume' | 'expect' = 'main'
    body.forEach((l, idx) => {
      if (l.k === 'assume' && mode !== 'assume') {
        if (idx === 0) line.instance = true
        mode = 'assume'; line.assume = []; line.assumeAt = l.from; return
      }
      if (l.k === 'expect' && mode !== 'expect') {
        mode = 'expect'; line.expect = []; line.expectAt = l.from; return
      }
      if (mode === 'main') line.main.push(l)
      else if (mode === 'assume') line.assume!.push(l)
      else line.expect!.push(l)
    })
    lines.push(line)
    from += text.length + 1
  })
  return lines
}

// ── 분류: 하이라이트용 토큰 ──────────────────────────────

export type TokType =
  | 'comment' | 'decl' | 'declName' | 'kind' | 'stmt' | 'name' | 'field' | 'type'
  | 'compUse' | 'string' | 'number' | 'time' | 'bytes' | 'path' | 'subject'
  | 'typeRef' | 'keyword' | 'bool' | 'op' | 'punct' | 'attrKey' | 'flag'
  | 'assumeMark' | 'expectMark' | 'instName' | 'hole'

export interface Token { from: number; to: number; type: TokType }

export const DECLS = new Set(['model', 'interface', 'system', 'component', 'app', 'sample', 'use'])
export const STMTS = new Set([
  'let', 'when', 'else', 'for', 'set', 'clear', 'create', 'add', 'remove', 'delete',
  'emit', 'fail', 'given', 'expect', 'open', 'on', 'check',
])
export const KEYWORDS = new Set(['on', 'in', 'to', 'from', 'and', 'or', 'not', 'where', 'find', 'sort', 'as', 'nothing', 'every'])
export const NAME_KINDS = new Set(['input', 'button', 'list', 'value', 'read', 'watch', 'call', 'notice'])
export const BUILTIN_TYPES = new Set([
  'Text', 'Number', 'Bool', 'Time', 'Duration', 'Length', 'Color', 'Path', 'Bytes',
  'List', 'Set', 'Map', 'Clock', 'Random',
])

const isUpper = (s: string) => /^[A-Z]/.test(s)

export type Ctx = 'top' | 'model' | 'interface' | 'system' | 'component' | 'app' | 'sample'

/** 각 줄이 어떤 선언 안에 있는지. system 이 조상에 있으면 system 문맥이 이긴다. */
export function contexts(lines: Line[]): Ctx[] {
  const stack: { indent: number; ctx: Ctx }[] = []
  return lines.map(line => {
    if (line.blank) return stack.length ? stack[stack.length - 1].ctx : 'top'
    while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop()
    const parent: Ctx = stack.length ? stack[stack.length - 1].ctx : 'top'
    const head = line.main[0]?.text
    if (head && DECLS.has(head) && head !== 'use') {
      const own = head as Ctx
      stack.push({ indent: line.indent, ctx: own })
    } else if (parent !== 'top') {
      stack.push({ indent: line.indent, ctx: parent })
    }
    return parent
  })
}

export function classify(doc: string, declared: Set<string> = collectDeclared(splitLines(doc))): Token[] {
  const lines = splitLines(doc)
  const ctxs = contexts(lines)
  const toks: Token[] = []
  const add = (l: Lexeme, type: TokType) => toks.push({ from: l.from, to: l.to, type })

  const refType = (l: Lexeme): TokType => {
    const root = l.text.split('.')[0]
    if (isUpper(root) && !declared.has(root) && !BUILTIN_TYPES.has(root)) return 'hole'
    return 'typeRef'
  }

  const expr = (ls: Lexeme[]) => {
    ls.forEach((l, i) => {
      const next = ls[i + 1]
      switch (l.k) {
        case 'str': strTokens(l, toks, declared); break
        case 'bytes': add(l, 'bytes'); break
        case 'num': add(l, 'number'); break
        case 'time': add(l, 'time'); break
        case 'subj': add(l, 'subject'); break
        case 'op': add(l, 'op'); break
        case 'punct': add(l, 'punct'); break
        case 'ident':
        case 'path':
          if (next && next.k === 'op' && next.text === '=' && l.k === 'ident') add(l, 'attrKey')
          else if (l.text === 'true' || l.text === 'false') add(l, 'bool')
          else if (KEYWORDS.has(l.text)) add(l, 'keyword')
          else if (isUpper(l.text)) add(l, refType(l))
          else add(l, 'path')
          break
      }
    })
  }

  lines.forEach((line, n) => {
    for (const l of line.lex) if (l.k === 'comment') add(l, 'comment')
    if (line.assumeAt !== undefined) toks.push({ from: line.assumeAt, to: line.assumeAt + 1, type: 'assumeMark' })
    if (line.expectAt !== undefined) toks.push({ from: line.expectAt, to: line.expectAt + 1, type: 'expectMark' })
    if (line.assume) {
      if (line.instance && line.assume[0]?.k === 'ident') {
        add(line.assume[0], 'instName')
        expr(line.assume.slice(1))
      } else expr(line.assume)
    }
    if (line.expect) expr(line.expect)

    const m = line.main
    if (!m.length) return
    const head = m[0]
    const ctx = ctxs[n]

    if (DECLS.has(head.text)) {
      add(head, 'decl')
      if (m[1] && (m[1].k === 'ident')) add(m[1], 'declName')
      attrs(m.slice(2))
      return
    }
    if (ctx === 'model' && !isUpper(head.text) && head.text !== 'check') {
      add(head, 'field')
      if (m[1]?.text === '=') { add(m[1], 'op'); expr(m.slice(2)) }
      else m.slice(1).forEach(l => (l.k === 'ident' || l.k === 'path') ? add(l, isUpper(l.text) ? (refType(l) === 'hole' ? 'hole' : 'type') : 'flag') : expr([l]))
      return
    }
    if (STMTS.has(head.text) && (ctx === 'system' || ctx === 'model' || ctx === 'app' || ctx === 'sample' || head.text === 'on')) {
      add(head, 'stmt')
      expr(m.slice(1))
      return
    }
    if (isUpper(head.text)) {
      add(head, refType(head) === 'hole' ? 'hole' : 'compUse')
      expr(m.slice(1))
      return
    }
    // interface 종류 줄: 종류 이름? 주인공값? 속성*
    add(head, 'kind')
    let i = 1
    if (NAME_KINDS.has(head.text) && m[1]?.k === 'ident' && m[2]?.text !== '=') { add(m[1], 'name'); i = 2 }
    const rest = m.slice(i)
    attrs(rest)
  })
  return toks.sort((a, b) => a.from - b.from || a.to - b.to)

  /** 속성 자리: key=값, 플래그, 괄호 안은 식 */
  function attrs(rest: Lexeme[]) {
    let depth = 0
    rest.forEach((l, j) => {
      const next = rest[j + 1]
      const prev = rest[j - 1]
      if (l.text === '(' || l.text === '[') depth++
      if (l.text === ')' || l.text === ']') depth--
      if (depth > 0 || l.k !== 'ident') return expr([l])
      if (next?.text === '=') add(l, 'attrKey')
      else if (prev?.text === '=' || KEYWORDS.has(l.text)) expr([l])
      else if (!isUpper(l.text) || /^[A-Z]+$/.test(l.text)) add(l, 'flag') // bold, single, GET
      else expr([l])
    })
  }
}

/** 문자열 안의 {보간} 을 따로 칠한다 */
function strTokens(l: Lexeme, toks: Token[], declared: Set<string>) {
  const s = l.text
  let start = 0
  let i = 0
  while (i < s.length) {
    if (s[i] === '{') {
      const end = s.indexOf('}', i)
      if (end < 0) break
      if (i > start) toks.push({ from: l.from + start, to: l.from + i, type: 'string' })
      toks.push({ from: l.from + i, to: l.from + i + 1, type: 'punct' })
      const inner = classifyExpr(s.slice(i + 1, end), l.from + i + 1, declared)
      toks.push(...inner)
      toks.push({ from: l.from + end, to: l.from + end + 1, type: 'punct' })
      i = end + 1
      start = i
      continue
    }
    i++
  }
  if (start < s.length) toks.push({ from: l.from + start, to: l.to, type: 'string' })
}

function classifyExpr(src: string, base: number, declared: Set<string>): Token[] {
  return lexLine(src, base).map(l => ({
    from: l.from, to: l.to,
    type: l.k === 'subj' ? 'subject'
      : l.k === 'num' ? 'number'
      : l.k === 'op' ? 'op'
      : l.k === 'punct' ? 'punct'
      : l.k === 'str' ? 'string'
      : isUpper(l.text) ? (declared.has(l.text.split('.')[0]) || BUILTIN_TYPES.has(l.text.split('.')[0]) ? 'typeRef' : 'hole')
      : 'path',
  }))
}

/** 최상위 선언 이름 + 가정 인스턴스 이름 */
export function collectDeclared(lines: Line[]): Set<string> {
  const s = new Set<string>()
  lines.forEach(line => {
    const m = line.main
    if (m[0] && DECLS.has(m[0].text) && m[1]) s.add(m[1].text) // component 안의 system 포함
    if (m[0]?.text === 'fail' && m[1]) s.add(m[1].text)         // 실패 이름은 fail 이 선언한다
    if (line.instance && line.assume?.[0]) s.add(line.assume[0].text)
  })
  return s
}
