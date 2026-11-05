// 식 파서 (Pratt). 줄 머리 부르기(f x key=v)도 여기서.
import { lexLine, type Tok } from './lex'

interface P { from: number; to: number }
export type E = P & (
  | { t: 'num'; v: number; unit?: string }
  | { t: 'str'; parts: (string | E)[] }
  | { t: 'time'; v: string }
  | { t: 'lit'; v: boolean | null }
  | { t: 'name'; name: string }
  | { t: 'type'; name: string }
  | { t: 'const'; v: string }
  | { t: 'subj' }
  | { t: 'member'; obj: E; name: string; opt?: boolean; nameFrom: number }
  | { t: 'index'; obj: E; idx: E }
  | { t: 'call'; fn: E; args: Arg[] }
  | { t: 'record'; fields: Arg[] }
  | { t: 'list'; items: E[] }
  | { t: 'bin'; op: string; l: E; r: E }
  | { t: 'un'; op: string; e: E }
  | { t: 'pipe'; l: E; r: E }
  | { t: 'spread'; e: E }
  | { t: 'cmd'; head: E; args: Arg[] }
  | { t: 'map'; pairs: { k: E; v: E }[] }
  | { t: 'match'; subj: E; arms: Arm[] }
  | { t: 'bad'; msg: string }
)
export interface Arg { key?: string; keyFrom?: number; value: E }
/** match · catch 갈래의 모양: Circle(r) · "paid" · else */
export type Pat =
  | { k: 'case'; name: string; from: number; to: number; binds: { name: string; from: number; to: number }[] }
  | { k: 'lit'; e: E }
  | { k: 'else' }
/** 갈래 하나 — node 는 줄 (몸통이 들여쓴 블록이면 node.children) */
export interface Arm { pat: Pat; body?: E; node: any }
export interface TypeRef { name: string; list: boolean; opt: boolean; text: string; from: number; to: number }

const PREC: Record<string, number> = {
  '|>': 1, '??': 2, or: 3, and: 4, '..': 5, '..<': 5, '..=': 5, '==': 5, '!=': 5, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7,
}

export class ParseError extends Error { constructor(msg: string, readonly at: number) { super(msg) } }

export class Parser {
  i = 0
  constructor(readonly toks: Tok[]) {}
  get peek(): Tok | undefined { return this.toks[this.i] }
  at(k: number) { return this.toks[this.i + k] }
  done() { return this.i >= this.toks.length }
  is(text: string, k = 0) { const t = this.at(k); return !!t && t.text === text && (t.k === 'op' || t.k === 'punct' || t.k === 'kw') }
  next() { return this.toks[this.i++] }
  eat(text: string) {
    if (!this.is(text)) throw new ParseError(`'${text}' 가 필요해`, this.peek?.from ?? this.end)
    return this.next()
  }
  get end() { return this.toks.length ? this.toks[this.toks.length - 1].to : 0 }

  expr(min = 0): E {
    let l = this.unary()
    while (!this.done()) {
      const t = this.peek!
      const op = (t.k === 'op' || (t.k === 'kw' && (t.text === 'and' || t.text === 'or'))) ? t.text : ''
      const p = PREC[op]
      if (!p || p <= min) break
      this.next()
      const r = this.expr(p)
      l = op === '|>' ? { t: 'pipe', l, r, from: l.from, to: r.to } : { t: 'bin', op, l, r, from: l.from, to: r.to }
    }
    return l
  }

  unary(): E {
    const t = this.peek
    if (t && ((t.k === 'op' && t.text === '-') || (t.k === 'kw' && t.text === 'not'))) {
      this.next(); const e = this.unary()
      return { t: 'un', op: t.text, e, from: t.from, to: e.to }
    }
    if (t && t.k === 'op' && t.text === '...') {
      this.next(); const e = this.unary()
      return { t: 'spread', e, from: t.from, to: e.to }
    }
    return this.postfix(this.primary())
  }

  primary(): E {
    const t = this.next()
    if (!t) throw new ParseError('값이 필요해', this.end)
    const P = { from: t.from, to: t.to }
    switch (t.k) {
      case 'num': {
        const m = /^([\d_]+(?:\.\d+)?)(.*)$/.exec(t.text)!
        return { t: 'num', v: Number(m[1].replace(/_/g, '')), unit: m[2] || undefined, ...P }
      }
      case 'time': return { t: 'time', v: t.text, ...P }
      case 'str': return { t: 'str', parts: strParts(t), ...P }
      case 'const': return { t: 'const', v: t.text, ...P }
      case 'type': return { t: 'type', name: t.text, ...P }
      case 'ident': return { t: 'name', name: t.text, ...P }
      case 'kw':
        if (t.text === 'true' || t.text === 'false') return { t: 'lit', v: t.text === 'true', ...P }
        if (t.text === 'none') return { t: 'lit', v: null, ...P }
        break
      case 'op':
        if (t.text === '.') {
          const n = this.peek
          if (n && (n.k === 'ident' || n.k === 'type') && n.from === t.to) {
            this.next()
            return { t: 'member', obj: { t: 'subj', ...P }, name: n.text, nameFrom: n.from, from: t.from, to: n.to }
          }
          return { t: 'subj', ...P }
        }
        break
      case 'punct':
        if (t.text === '(') return this.paren(t)
        if (t.text === '[') {
          // 맵: [:] · ["a": 1]
          if (this.is(':') && this.is(']', 1)) { this.next(); const e = this.next(); return { t: 'map', pairs: [], from: t.from, to: e.to } }
          if (!this.is(']')) {
            const save = this.i
            const k0 = this.expr()
            if (this.is(':')) {
              this.next()
              const pairs = [{ k: k0, v: this.expr() }]
              while (this.is(',')) { this.next(); if (this.is(']')) break; const k = this.expr(); this.eat(':'); pairs.push({ k, v: this.expr() }) }
              const e = this.eat(']')
              return { t: 'map', pairs, from: t.from, to: e.to }
            }
            this.i = save
          }
          const items: E[] = []
          while (!this.is(']')) {
            items.push(this.expr())
            if (!this.is(']')) this.eat(',')
          }
          const e = this.eat(']')
          return { t: 'list', items, from: t.from, to: e.to }
        }
    }
    throw new ParseError(`여기에 '${t.text}' 는 올 수 없어`, t.from)
  }

  paren(open: Tok): E {
    if (this.is(')')) { const e = this.next(); return { t: 'record', fields: [], from: open.from, to: e.to } }
    const isRec = (this.peek?.k === 'ident' || this.peek?.k === 'str' || this.peek?.k === 'type') && this.is(':', 1) || this.is('...')
    if (isRec) {
      const fields = this.args(')', true)
      const e = this.eat(')')
      return { t: 'record', fields, from: open.from, to: e.to }
    }
    const inner = this.expr()
    this.eat(')')
    return inner
  }

  /** f(a, k=v, k: v, ...x) */
  args(close: string, recordOnly = false): Arg[] {
    const out: Arg[] = []
    while (!this.is(close) && !this.done()) {
      const t = this.peek!
      if ((t.k === 'ident' || t.k === 'str' || t.k === 'type') && (this.is(':', 1) || (!recordOnly && this.is('=', 1)))) {
        this.next(); this.next()
        out.push({ key: t.k === 'str' ? t.text.slice(1, -1) : t.text, keyFrom: t.from, value: this.expr() })
      } else out.push({ value: this.expr() })
      if (!this.is(close)) this.eat(',')
    }
    return out
  }

  postfix(e: E): E {
    while (!this.done()) {
      const t = this.peek!
      if (t.k === 'op' && (t.text === '.' || t.text === '?.') && t.from === e.to) {
        const n = this.at(1)
        if (!n || (n.k !== 'ident' && n.k !== 'type' && n.k !== 'kw')) break
        this.next(); this.next()
        e = { t: 'member', obj: e, name: n.text, opt: t.text === '?.', nameFrom: n.from, from: e.from, to: n.to }
      } else if (t.k === 'punct' && t.text === '(' && t.from === e.to) {
        this.next()
        const args = this.args(')')
        const c = this.eat(')')
        e = { t: 'call', fn: e, args, from: e.from, to: c.to }
      } else if (t.k === 'punct' && t.text === '[' && t.from === e.to) {
        this.next()
        const idx = this.expr()
        const c = this.eat(']')
        e = { t: 'index', obj: e, idx, from: e.from, to: c.to }
      } else break
    }
    return e
  }
}

function strParts(t: Tok): (string | E)[] {
  const s = t.text.slice(1, t.text.endsWith('"') && t.text.length > 1 ? -1 : undefined)
  const out: (string | E)[] = []
  let buf = '', i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) { buf += s[i + 1] === 'n' ? '\n' : s[i + 1]; i += 2; continue }
    if (c === '{') {
      let j = i + 1, d = 1
      while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; if (d) j++ }
      if (buf) out.push(buf), buf = ''
      const inner = s.slice(i + 1, j)
      const toks = lexLine(inner, t.from + 1 + i + 1)
      try { const p = new Parser(toks); out.push(p.expr()) } catch { out.push({ t: 'bad', msg: '식이 이상해', from: t.from, to: t.to }) }
      i = j + 1; continue
    }
    buf += c; i++
  }
  if (buf) out.push(buf)
  return out
}

export function parseType(toks: Tok[]): TypeRef | undefined {
  if (!toks.length) return
  const text = toks.map(t => t.text).join('').replace(/\|/g, ' | ')
  const first = toks[0]
  let name = first.text, list = false, opt = false
  if (first.k === 'str') name = 'Text'
  for (const t of toks.slice(1)) {
    if (t.text === '[') list = true
    if (t.text === '?' || t.text === '??') opt = true
  }
  if (text.endsWith('?')) opt = true
  return { name, list, opt, text, from: first.from, to: toks[toks.length - 1].to }
}

/** 줄 머리 부르기의 나머지: 위치 인자 · key=v · name: Type · 끝 if 조건 */
export interface CallRest { args: Arg[]; binders: { name: string; from: number; to: number; type?: TypeRef }[]; cond?: E }

export function parseCallRest(p: Parser): CallRest {
  const out: CallRest = { args: [], binders: [] }
  while (!p.done()) {
    const t = p.peek!
    if (t.k === 'kw' && t.text === 'if') { p.next(); out.cond = p.expr(); break }
    if (t.k === 'ident' && p.is('=', 1)) {
      p.next(); p.next()
      out.args.push({ key: t.text, keyFrom: t.from, value: p.expr() })
      continue
    }
    if (t.k === 'ident' && p.is(':', 1)) {
      p.next(); p.next()
      const tt: Tok[] = []
      while (!p.done()) {
        const n = p.peek!
        if (tt.length && n.from > tt[tt.length - 1].to && !(n.text === '?' || n.text === '[' || n.text === ']')) break
        tt.push(p.next())
      }
      out.binders.push({ name: t.text, from: t.from, to: t.to, type: parseType(tt) })
      continue
    }
    out.args.push({ value: p.expr() })
  }
  return out
}

/** 오른쪽 값: 보통 식, 또는 괄호 없는 부르기 `post "/x" body=draft` */
/** 갈래 머리: Circle(r, x) · Dot · "paid" · 3 · none · else. 나머지 토큰 위치도 */
export function parsePat(toks: Tok[]): { pat: Pat; rest: number } {
  const t = toks[0]
  if (!t) throw new ParseError('갈래 모양이 필요해 (예: Circle(r))', 0)
  if (t.k === 'kw' && t.text === 'else') return { pat: { k: 'else' }, rest: 1 }
  if (t.k === 'type') {
    const binds: { name: string; from: number; to: number }[] = []
    let i = 1, to = t.to
    if (toks[1]?.text === '(' && toks[1].from === t.to) {
      i = 2
      while (i < toks.length && toks[i].text !== ')') {
        const b = toks[i]
        if (b.k !== 'ident') throw new ParseError('갈래 안엔 받을 이름 (예: Circle(r))', b.from)
        binds.push({ name: b.text, from: b.from, to: b.to }); i++
        if (toks[i]?.text === ',') i++
      }
      if (toks[i]?.text !== ')') throw new ParseError("')' 가 필요해", t.to)
      to = toks[i].to; i++
    }
    return { pat: { k: 'case', name: t.text, from: t.from, to, binds }, rest: i }
  }
  const p = new Parser([t])
  return { pat: { k: 'lit', e: p.primary() }, rest: 1 }
}

export function parseValue(toks: Tok[]): E {
  // match 값  (갈래는 다음 줄들)
  if (toks[0]?.k === 'kw' && toks[0].text === 'match') {
    if (toks.length < 2) throw new ParseError('match 다음엔 고를 값', toks[0].to)
    const subj = parseValue(toks.slice(1))
    return { t: 'match', subj, arms: [], from: toks[0].from, to: subj.to }
  }
  const p = new Parser(toks)
  const t = p.peek
  if (t && t.k === 'ident' && toks.length > 1) {
    const n = toks[1]
    const startsArg = n.k === 'str' || n.k === 'num' || n.k === 'time' || n.k === 'const' || n.k === 'type'
      || (n.k === 'ident' && !(n.from === t.to)) || (n.k === 'punct' && (n.text === '[' ) && n.from > t.to)
      || (n.k === 'punct' && n.text === '(' && n.from > t.to)
    if (startsArg) {
      p.next()
      const head: E = { t: 'name', name: t.text, from: t.from, to: t.to }
      const rest = parseCallRest(p)
      const last = toks[toks.length - 1]
      return { t: 'cmd', head, args: rest.args, from: t.from, to: last.to }
    }
  }
  const e = p.expr()
  if (!p.done()) throw new ParseError(`'${p.peek!.text}' 는 여기 올 수 없어`, p.peek!.from)
  return e
}
