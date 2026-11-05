// 한 줄 렉서. 위치는 문서 전체 기준(base 더함).

export type K =
  | 'kw' | 'ident' | 'type' | 'const' | 'num' | 'str' | 'time'
  | 'op' | 'punct' | 'ex' | 'expect' | 'comment' | 'bad'

export interface Tok { k: K; text: string; from: number; to: number }

export const KEYWORDS = new Set([
  'use', 'model', 'check', 'fn', 'for', 'in', 'if', 'else', 'match', 'catch', 'fail',
  'as', 'and', 'or', 'not', 'true', 'false', 'none',
])

const OPS = ['...', '..<', '..=', '..', '|>', '??', '?.', '==', '!=', '>=', '<=', '+=', '-=', '->', '?', '=', '+', '-', '*', '/', '%', '>', '<', '.', '|']
const PUNCT = '()[],:{}'

const isIdStart = (c: string) => /[\p{L}_]/u.test(c)
const isId = (c: string) => /[\p{L}\p{N}_]/u.test(c)

export function lexLine(src: string, base = 0): Tok[] {
  const out: Tok[] = []
  let i = 0
  const push = (k: K, from: number, to: number) => out.push({ k, text: src.slice(from, to), from: base + from, to: base + to })
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') { i++; continue }
    // 주석
    if (c === '/' && src[i + 1] === '/') { push('comment', i, src.length); break }
    // 줄 끝 예시 · 기대: 앞뒤가 공백인 ? / !
    if ((c === '?' || c === '!') && (i === 0 || src[i - 1] === ' ') && (src[i + 1] === ' ' || i + 1 === src.length)) {
      push(c === '?' ? 'ex' : 'expect', i, i + 1); i++; continue
    }
    if (c === '"') {
      let j = i + 1, depth = 0
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        else if (src[j] === '"' && depth <= 0) break
        j++
      }
      push('str', i, Math.min(j + 1, src.length)); i = j + 1; continue
    }
    if (/\d/.test(c)) {
      const t = /^\d{1,2}:\d{2}(?!\d)/.exec(src.slice(i))
      if (t) { push('time', i, i + t[0].length); i += t[0].length; continue }
      const m = /^\d[\d_]*(\.\d+)?(px|ms|s|%)?/.exec(src.slice(i))!
      push('num', i, i + m[0].length); i += m[0].length; continue
    }
    if (isIdStart(c)) {
      let j = i + 1
      while (j < src.length && isId(src[j])) j++
      // x-key: 처럼 하이픈 이름은 바로 뒤에 : 가 올 때만
      const h = /^(-[\p{L}][\p{L}\p{N}_]*)+:/u.exec(src.slice(j))
      if (h) j += h[0].length - 1
      const w = src.slice(i, j)
      const k: K = KEYWORDS.has(w) ? 'kw'
        : /^[A-Z][A-Z]+$/.test(w) ? 'const'
        : /^[A-Z]/.test(w) ? 'type' : 'ident'
      push(k, i, j); i = j; continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (op) { push('op', i, i + op.length); i += op.length; continue }
    if (PUNCT.includes(c)) { push('punct', i, i + 1); i++; continue }
    push('bad', i, i + 1); i++
  }
  return out
}

export interface SrcLine {
  no: number           // 0부터
  from: number
  text: string
  indent: number
  blank: boolean
  toks: Tok[]          // 전부
  body: Tok[]          // 예시·기대·주석 앞까지
  ex?: Tok[]           // ? 뒤
  expect?: Tok[]       // ! 뒤
  exAt?: number
  expectAt?: number
}

export function splitLines(doc: string): SrcLine[] {
  const out: SrcLine[] = []
  let from = 0
  doc.split('\n').forEach((text, no) => {
    const toks = lexLine(text, from)
    const code = toks.filter(t => t.k !== 'comment')
    const line: SrcLine = { no, from, text, indent: /^ */.exec(text)![0].length, blank: code.length === 0, toks, body: code }
    const ei = code.findIndex(t => t.k === 'ex'), xi = code.findIndex(t => t.k === 'expect')
    const cut = [ei, xi].filter(x => x >= 0)
    if (cut.length) {
      line.body = code.slice(0, Math.min(...cut))
      if (ei >= 0) { line.ex = code.slice(ei + 1, xi > ei ? xi : undefined); line.exAt = code[ei].from }
      if (xi >= 0) { line.expect = code.slice(xi + 1, ei > xi ? ei : undefined); line.expectAt = code[xi].from }
    }
    out.push(line)
    from += text.length + 1
  })
  return out
}
