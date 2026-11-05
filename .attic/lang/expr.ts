// 식 파서. 한 줄의 렉심을 받아 AST 로.

import { lexLine, type Lexeme } from './tokenize'

export type Expr =
  | { t: 'num'; v: number; unit?: string }
  | { t: 'str'; parts: (string | Expr)[] }
  | { t: 'bytes'; v: string }
  | { t: 'time'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'path'; root: string; segs: string[]; text: string }
  | { t: 'list'; items: Expr[] }
  | { t: 'set'; items: Expr[] }
  | { t: 'ctor'; type: string; attrs: Attr[] }
  | { t: 'call'; fn: string; args: Expr[] }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'find' | 'where'; src: Expr; pred: Expr }
  | { t: 'bad'; text: string }

export interface Attr { key: string; value: Expr }

const PREC: Record<string, number> = {
  or: 1, and: 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '??': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
  find: 7, where: 7,
}

const isUpper = (s: string) => /^[A-Z]/.test(s)

export class Parser {
  i = 0
  constructor(public ls: Lexeme[]) {}

  peek(o = 0) { return this.ls[this.i + o] }
  next() { return this.ls[this.i++] }
  done() { return this.i >= this.ls.length }
  is(text: string, o = 0) { return this.peek(o)?.text === text }
  eat(text: string) { if (this.is(text)) { this.i++; return true } return false }

  expr(min = 0): Expr {
    let l = this.unary()
    for (;;) {
      const tok = this.peek()
      if (!tok) break
      const op = tok.text
      const p = PREC[op]
      if (p === undefined || p < min || (tok.k !== 'op' && tok.k !== 'ident')) break
      // 속성 키처럼 보이면 (ident =) 식이 아니다
      if (tok.k === 'ident' && this.is('=', 1)) break
      this.i++
      if (op === 'find' || op === 'where') {
        const pred = this.unary()
        l = { t: op, src: l, pred }
        continue
      }
      const r = this.expr(p + 1)
      l = { t: 'bin', op, l, r }
    }
    return l
  }

  unary(): Expr {
    if (this.is('-')) { this.i++; return { t: 'un', op: '-', e: this.unary() } }
    if (this.is('not')) { this.i++; return { t: 'un', op: 'not', e: this.unary() } }
    return this.primary()
  }

  primary(): Expr {
    const tok = this.next()
    if (!tok) return { t: 'bad', text: '' }
    switch (tok.k) {
      case 'num': {
        const m = /^(\d+(?:\.\d+)?)([a-z%]+)?$/.exec(tok.text)!
        return { t: 'num', v: parseFloat(m[1]), unit: m[2] }
      }
      case 'str': return { t: 'str', parts: parseStr(tok.text.slice(1, -1)) }
      case 'bytes': return { t: 'bytes', v: tok.text.slice(2, -1) }
      case 'time': return { t: 'time', v: tok.text }
      case 'subj': {
        const segs = tok.text.slice(1).split('.').filter(Boolean)
        return { t: 'path', root: '.', segs, text: tok.text }
      }
      case 'ident':
      case 'path': {
        if (tok.text === 'true' || tok.text === 'false') return { t: 'bool', v: tok.text === 'true' }
        const [root, ...segs] = tok.text.split('.')
        // 호출: sum(…), Disk.file(path)
        if (this.is('(') && this.peek()!.from === tok.to) {
          this.i++
          const args: Expr[] = []
          while (!this.done() && !this.is(')')) { args.push(this.expr()); this.eat(',') }
          this.eat(')')
          return { t: 'call', fn: tok.text, args }
        }
        // 생성자: Line product=펜 qty=3
        if (tok.k === 'ident' && isUpper(tok.text) && this.peek()?.k === 'ident' && this.is('=', 1)) {
          return { t: 'ctor', type: tok.text, attrs: this.attrs() }
        }
        return { t: 'path', root, segs, text: tok.text }
      }
      case 'punct':
        if (tok.text === '(') { const e = this.expr(); this.eat(')'); return e }
        if (tok.text === '[' || tok.text === '{') {
          const close = tok.text === '[' ? ']' : '}'
          const items: Expr[] = []
          while (!this.done() && !this.is(close)) { items.push(this.expr()); this.eat(',') }
          this.eat(close)
          return { t: tok.text === '[' ? 'list' : 'set', items }
        }
    }
    return { t: 'bad', text: tok.text }
  }

  /** key=값 key=값 … (값은 연산 없는 원자. 연산은 괄호로) */
  attrs(): Attr[] {
    const out: Attr[] = []
    while (this.peek()?.k === 'ident' && this.is('=', 1)) {
      const key = this.next()!.text
      this.i++
      out.push({ key, value: this.unary() })
    }
    return out
  }
}

export function parseStr(body: string): (string | Expr)[] {
  const parts: (string | Expr)[] = []
  let buf = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      const end = body.indexOf('}', i)
      if (end < 0) { buf += body.slice(i); break }
      if (buf) parts.push(buf)
      buf = ''
      parts.push(new Parser(lexLine(body.slice(i + 1, end))).expr())
      i = end
    } else buf += body[i]
  }
  if (buf) parts.push(buf)
  return parts
}

export const parseExpr = (ls: Lexeme[]) => new Parser(ls).expr()
