// 분석기: 개요 트리 → 세계(가정) → 모양 추론 → 가정 실행 → 줄별 주석

import {
  splitLines, classify, collectDeclared, DECLS, NAME_KINDS,
  type Line, type Lexeme,
} from './tokenize'
import { Parser, parseExpr, type Expr, type Attr } from './expr'

// ── 개요 ───────────────────────────────────────────────

export interface Node { line: Line; head: string; children: Node[]; parent?: Node }

export function outline(lines: Line[]): Node[] {
  const roots: Node[] = []
  const stack: Node[] = []
  for (const line of lines) {
    if (line.blank) continue
    const node: Node = { line, head: line.main[0]?.text ?? (line.instance ? '?' : ''), children: [] }
    while (stack.length && stack[stack.length - 1].line.indent >= line.indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) { node.parent = parent; parent.children.push(node) } else roots.push(node)
    stack.push(node)
  }
  return roots
}

// ── 값 ─────────────────────────────────────────────────

export interface Obj { model: string; name?: string; f: Record<string, V> }
export type V =
  | number | string | boolean | null
  | V[] | Obj
  | { tag: 'set'; items: V[] } | { tag: 'time'; v: string } | { tag: 'bytes'; v: string }
  | { tag: 'hole'; why: string }

const hole = (why: string): V => ({ tag: 'hole', why })
export const isHole = (v: V): v is { tag: 'hole'; why: string } => !!v && typeof v === 'object' && 'tag' in v && v.tag === 'hole'
export const isObj = (v: V): v is Obj => !!v && typeof v === 'object' && 'model' in v
export const isSet = (v: V): v is { tag: 'set'; items: V[] } => !!v && typeof v === 'object' && 'tag' in v && v.tag === 'set'
export const items = (v: V): V[] | undefined => Array.isArray(v) ? v : isSet(v) ? v.items : undefined

export const truthyV = (v: V) => truthy(v)

export function fmt(v: V, depth = 0): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000)
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return `[${v.map(x => fmt(x, depth + 1)).join(', ')}]`
  if (isObj(v)) {
    if (v.name) return v.name
    if (depth > 1) return v.model
    const inner = Object.entries(v.f).map(([k, x]) => `${k}=${fmt(x, depth + 1)}`).join(' ')
    return `${v.model}{${inner}}`
  }
  switch (v.tag) {
    case 'set': return `{${v.items.map(x => fmt(x, depth + 1)).join(', ')}}`
    case 'time': return v.v
    case 'bytes': return `b"${v.v}"`
    case 'hole': return '◌'
  }
}

export const plain = (v: V) => typeof v === 'string' ? v : fmt(v)
const truthy = (v: V) => !(v === false || v === null || v === 0 || v === '' || isHole(v) || (Array.isArray(v) && v.length === 0))
const same = (a: V, b: V) => (isObj(a) || isObj(b)) ? a === b : fmt(a) === fmt(b)

// ── 세계: 선언 + 가정 ──────────────────────────────────

interface FieldDef { name: string; type?: string; derived?: Expr; line: Line }
export interface ModelDef { name: string; single: boolean; fields: Map<string, FieldDef>; checks: { e: Expr; line: Line }[]; instances: Obj[] }
export interface ComponentDef { name: string; of?: string; node: Node }
export interface SystemDef { name: string; node: Node; comp?: ComponentDef; trigger: string; assumed: boolean; payload: Attr[] }

export class World {
  models = new Map<string, ModelDef>()
  interfaces = new Set<string>()
  components = new Map<string, ComponentDef>()
  systems: SystemDef[] = []
  names = new Map<string, Obj>()
  singles = new Map<string, Obj>()
  ports = new Map<string, V>()
  /** 실행 중에 만들어진 것 / 지워진 것 (미리보기 시뮬레이션용) */
  created: Obj[] = []
  deleted = new Set<Obj>()

  constructor(public roots: Node[]) {
    const pending: (() => void)[] = []
    for (const root of roots) {
      const m = root.line.main
      const name = m[1]?.text ?? ''
      switch (root.head) {
        case 'model': {
          const def: ModelDef = { name, single: m.some(l => l.text === 'single'), fields: new Map(), checks: [], instances: [] }
          this.models.set(name, def)
          if (def.single) this.singles.set(name, { model: name, f: {} })
          for (const c of root.children) {
            const cm = c.line.main
            if (c.line.instance && c.line.assume?.[0]) {
              const obj: Obj = { model: name, name: c.line.assume[0].text, f: {} }
              def.instances.push(obj)
              this.names.set(obj.name!, obj)
              const attrs = new Parser(c.line.assume.slice(1)).attrs()
              pending.push(() => attrs.forEach(a => { obj.f[a.key] = this.eval(a.value, {}) }))
            } else if (c.head === 'check') {
              def.checks.push({ e: parseExpr(cm.slice(1)), line: c.line })
            } else if (cm[0]) {
              const f: FieldDef = { name: c.head, line: c.line }
              if (cm[1]?.text === '=') f.derived = parseExpr(cm.slice(2))
              else f.type = cm.slice(1).map(l => l.text).join('')
              def.fields.set(f.name, f)
              if (c.line.assume?.length && def.single) {
                const e = parseExpr(c.line.assume)
                pending.push(() => { this.singles.get(name)!.f[f.name] = this.eval(e, {}) })
              }
            }
          }
          break
        }
        case 'interface':
          this.interfaces.add(name)
          walk(root, n => {
            const nm = n.line.main
            if (NAME_KINDS.has(n.head) && nm[1]?.k === 'ident' && n.line.assume?.length) {
              const e = parseExpr(n.line.assume)
              pending.push(() => this.ports.set(`${name}.${nm[1].text}`, this.eval(e, {})))
            }
          })
          break
        case 'component': {
          const of = attrOf(m, 'of')
          const comp: ComponentDef = { name, of, node: root }
          this.components.set(name, comp)
          for (const c of root.children) if (c.head === 'system') this.addSystem(c, comp)
          break
        }
        case 'system':
          this.addSystem(root)
          break
      }
    }
    // 어디서든 `? Clock.now=14:02` 처럼 경로를 가정
    for (const root of roots) walk(root, n => {
      const a = n.line.assume
      if (!a || n.line.instance || n.head === 'system') return
      if (a[0]?.k === 'path' && a[1]?.text === '=') {
        const e = parseExpr(a.slice(2))
        pending.push(() => this.ports.set(a[0].text, this.eval(e, {})))
      }
    })
    pending.forEach(p => p())
  }

  addSystem(node: Node, comp?: ComponentDef) {
    const m = node.line.main
    const onAt = m.findIndex(l => l.text === 'on')
    let trigger = onAt >= 0 ? m.slice(onAt + 1).map(l => l.text).join(' ') : '◌'
    if (comp && !trigger.includes('.')) trigger = `${comp.name}.${trigger}`
    const assumed = node.line.assume !== undefined
    const payload = assumed ? new Parser(node.line.assume!).attrs() : []
    this.systems.push({ name: m[1]?.text ?? '◌', node, comp, trigger, assumed, payload })
  }

  /** 가정 세계에 있는 model 인스턴스 전부 (이름 붙은 것 + 값 속에 들어 있는 것) */
  instancesOf(model: string): Obj[] {
    const seen = new Set<Obj>()
    const visit = (v: V) => {
      if (isObj(v)) {
        if (seen.has(v) || this.deleted.has(v)) return
        if (v.model === model) seen.add(v)
        Object.values(v.f).forEach(visit)
      } else items(v)?.forEach(visit)
    }
    this.names.forEach(visit)
    this.singles.forEach(visit)
    this.ports.forEach(visit)
    this.created.forEach(visit)
    return [...seen]
  }

  // ── 식 계산 ──

  eval(e: Expr, env: Env): V {
    switch (e.t) {
      case 'num': return e.v
      case 'str': return e.parts.map(p => typeof p === 'string' ? p : plain(this.eval(p, env))).join('')
      case 'bytes': return { tag: 'bytes', v: e.v }
      case 'time': return { tag: 'time', v: e.v }
      case 'bool': return e.v
      case 'list': return e.items.map(x => this.eval(x, env))
      case 'set': return { tag: 'set', items: e.items.map(x => this.eval(x, env)) }
      case 'ctor': {
        const o: Obj = { model: e.type, f: {} }
        e.attrs.forEach(a => { o.f[a.key] = this.eval(a.value, env) })
        return o
      }
      case 'path': return this.path(e, env)
      case 'call': {
        const args = e.args.map(a => this.eval(a, env))
        const xs = items(args[0])
        switch (e.fn) {
          case 'sum': return xs ? xs.reduce<number>((s, x) => s + (typeof x === 'number' ? x : NaN), 0) : hole('sum')
          case 'count': return xs ? xs.length : hole('count')
          case 'min': return xs?.length ? Math.min(...(xs as number[])) : hole('min')
          case 'max': return xs?.length ? Math.max(...(xs as number[])) : hole('max')
        }
        const key = `${e.fn}(${args.map(fmt).join(', ')})`
        return this.ports.has(key) ? this.ports.get(key)! : hole(key)
      }
      case 'un': {
        const v = this.eval(e.e, env)
        if (isHole(v)) return v
        return e.op === '-' ? -(v as number) : !truthy(v)
      }
      case 'bin': {
        const l = this.eval(e.l, env)
        if (e.op === 'and') return truthy(l) ? this.eval(e.r, env) : l
        if (e.op === 'or') return truthy(l) ? l : this.eval(e.r, env)
        if (e.op === '??') return (l === null || isHole(l)) ? this.eval(e.r, env) : l
        const r = this.eval(e.r, env)
        if (isHole(l)) return l
        if (isHole(r)) return r
        switch (e.op) {
          case '==': return same(l, r)
          case '!=': return !same(l, r)
          case '<': return (l as number) < (r as number)
          case '<=': return (l as number) <= (r as number)
          case '>': return (l as number) > (r as number)
          case '>=': return (l as number) >= (r as number)
          case '+': return (typeof l === 'string' || typeof r === 'string') ? plain(l) + plain(r) : (l as number) + (r as number)
          case '-': return (l as number) - (r as number)
          case '*': return (l as number) * (r as number)
          case '/': return (l as number) / (r as number)
          case '%': return (l as number) % (r as number)
        }
        return hole(e.op)
      }
      case 'find':
      case 'where': {
        const xs = items(this.eval(e.src, env))
        if (!xs) return hole(e.t)
        const hit = xs.filter(x => truthy(this.eval(e.pred, { ...env, subj: x })))
        return e.t === 'find' ? (hit[0] ?? null) : hit
      }
      case 'bad': return hole(e.text)
    }
  }

  path(e: Extract<Expr, { t: 'path' }>, env: Env): V {
    let v: V
    let segs = e.segs
    const root = e.root
    if (root === '.') v = env.subj ?? hole('.')
    else if (env.vars?.has(root)) v = env.vars.get(root)!
    else if (this.names.has(root)) v = this.names.get(root)!
    else if (this.singles.has(root)) v = this.singles.get(root)!
    else if (this.models.has(root) && segs.length === 0) v = this.instancesOf(root)
    else {
      // 바깥 값: 가장 긴 접두사로 찾는다 (Chat.draft, Disk.changed.path)
      for (let k = segs.length; k >= 1; k--) {
        const key = [root, ...segs.slice(0, k)].join('.')
        if (env.ports?.has(key)) { v = env.ports.get(key)!; segs = segs.slice(k); break }
        if (this.ports.has(key)) { v = this.ports.get(key)!; segs = segs.slice(k); break }
      }
      v ??= hole(e.text)
    }
    for (const s of segs) v = this.field(v, s)
    return v
  }

  field(v: V, seg: string): V {
    if (isHole(v)) return v
    if (isObj(v)) {
      if (seg in v.f) return v.f[seg]
      const d = this.models.get(v.model)?.fields.get(seg)?.derived
      if (d) return this.eval(d, { subj: v })
      return hole(`${v.model}.${seg}`)
    }
    const xs = items(v)
    if (xs) return xs.map(x => this.field(x, seg))
    return hole(seg)
  }
}

export interface Env { subj?: V; vars?: Map<string, V>; ports?: Map<string, V> }

function walk(n: Node, f: (n: Node) => void) { f(n); n.children.forEach(c => walk(c, f)) }
function attrOf(m: Lexeme[], key: string) {
  const i = m.findIndex((l, j) => l.text === key && m[j + 1]?.text === '=')
  return i >= 0 ? m[i + 2]?.text : undefined
}

// ── 문장 ───────────────────────────────────────────────

export type Stmt =
  | { s: 'let'; name: string; e: Expr }
  | { s: 'when'; e: Expr }
  | { s: 'else' }
  | { s: 'for'; name: string; e: Expr }
  | { s: 'set'; target: Expr; e: Expr }
  | { s: 'clear'; target: Expr }
  | { s: 'create'; type: string; attrs: Attr[] }
  | { s: 'add' | 'remove'; e: Expr; target: Expr }
  | { s: 'delete'; e: Expr }
  | { s: 'emit'; port: string; attrs: Attr[] }
  | { s: 'fail'; name: string; attrs: Attr[] }
  | { s: 'use'; comp: string; attrs: Attr[] }
  | { s: 'other' }

export function parseStmt(n: Node): Stmt {
  const p = new Parser(n.line.main.slice(1))
  const word = () => p.next()?.text ?? '◌'
  switch (n.head) {
    case 'let': { const name = word(); p.eat('='); return { s: 'let', name, e: p.expr() } }
    case 'when': return { s: 'when', e: p.expr() }
    case 'else': return { s: 'else' }
    case 'for': { const name = word(); p.eat('in'); return { s: 'for', name, e: p.expr() } }
    case 'set': { const target = p.unary(); p.eat('='); return { s: 'set', target, e: p.expr() } }
    case 'clear': return { s: 'clear', target: p.unary() }
    case 'create': { const type = word(); return { s: 'create', type, attrs: p.attrs() } }
    case 'add': case 'remove': {
      const e = p.expr(); p.eat('to'); p.eat('from')
      return { s: n.head, e, target: p.unary() }
    }
    case 'delete': return { s: 'delete', e: p.expr() }
    case 'emit': { const port = word(); return { s: 'emit', port, attrs: p.attrs() } }
    case 'fail': { const name = word(); return { s: 'fail', name, attrs: p.attrs() } }
  }
  if (/^[A-Z]/.test(n.head)) { p.i = 0; const comp = word(); return { s: 'use', comp, attrs: p.attrs() } }
  return { s: 'other' }
}

// ── 모양 추론 ──────────────────────────────────────────

export interface Shape { name: string; on: string; reads: string[]; writes: string[]; emits: string[]; fails: string[]; line: number }

const elem = (t?: string) => t?.replace(/^(List|Set)<(.+)>$/, '$2')

export class Shaper {
  reads: string[] = []
  writes: string[] = []
  emits: string[] = []
  fails: string[] = []
  constructor(public w: World) {}

  push(arr: string[], x?: string) { if (x && !arr.includes(x)) arr.push(x) }

  /** 경로의 타입과 위치(Owner.field) */
  locate(e: Expr, scope: Map<string, string | undefined>, subjT?: string): { type?: string; loc?: string } {
    if (e.t !== 'path') return { type: this.typeOf(e, scope, subjT) }
    let type: string | undefined
    let loc: string | undefined
    const segs = [...e.segs]
    if (e.root === '.') type = subjT
    else if (scope.has(e.root)) type = scope.get(e.root)
    else if (this.w.names.has(e.root)) type = this.w.names.get(e.root)!.model
    else if (this.w.singles.has(e.root)) type = e.root
    else if (this.w.models.has(e.root)) type = `List<${e.root}>`
    else return { loc: e.text } // interface · 바깥 값: 경로 그대로가 위치
    for (const s of segs) {
      const owner = elem(type)
      const f = owner ? this.w.models.get(owner)?.fields.get(s) : undefined
      loc = owner ? `${owner}.${s}` : s
      type = f?.type
    }
    return { type, loc }
  }

  typeOf(e: Expr, scope: Map<string, string | undefined>, subjT?: string): string | undefined {
    switch (e.t) {
      case 'path': return this.locate(e, scope, subjT).type
      case 'ctor': return e.type
      case 'find': return elem(this.typeOf(e.src, scope, subjT))
      case 'where': return this.typeOf(e.src, scope, subjT)
      case 'num': return 'Number'
      case 'str': return 'Text'
    }
    return undefined
  }

  read(e: Expr, scope: Map<string, string | undefined>, subjT?: string) {
    switch (e.t) {
      case 'path': this.push(this.reads, this.locate(e, scope, subjT).loc); break
      case 'str': e.parts.forEach(p => typeof p !== 'string' && this.read(p, scope, subjT)); break
      case 'list': case 'set': e.items.forEach(x => this.read(x, scope, subjT)); break
      case 'ctor': e.attrs.forEach(a => this.read(a.value, scope, subjT)); break
      case 'call':
        if (/^[A-Z]/.test(e.fn)) this.push(this.reads, e.fn)
        e.args.forEach(a => this.read(a, scope, subjT)); break
      case 'bin': this.read(e.l, scope, subjT); this.read(e.r, scope, subjT); break
      case 'un': this.read(e.e, scope, subjT); break
      case 'find': case 'where':
        this.read(e.src, scope, subjT)
        this.read(e.pred, scope, elem(this.typeOf(e.src, scope, subjT)))
        break
    }
  }

  block(nodes: Node[], scope: Map<string, string | undefined>, subjT?: string) {
    for (const n of nodes) {
      const st = parseStmt(n)
      const inner = new Map(scope)
      switch (st.s) {
        case 'let': this.read(st.e, scope, subjT); scope.set(st.name, this.typeOf(st.e, scope, subjT)); break
        case 'when': this.read(st.e, scope, subjT); break
        case 'for': this.read(st.e, scope, subjT); inner.set(st.name, elem(this.typeOf(st.e, scope, subjT))); break
        case 'set': this.read(st.e, scope, subjT); this.push(this.writes, '~ ' + (this.locate(st.target, scope, subjT).loc ?? '◌')); break
        case 'clear': this.push(this.writes, '~ ' + (this.locate(st.target, scope, subjT).loc ?? '◌')); break
        case 'create': st.attrs.forEach(a => this.read(a.value, scope, subjT)); this.push(this.writes, '+ ' + st.type); break
        case 'add': case 'remove':
          this.read(st.e, scope, subjT)
          this.push(this.writes, (st.s === 'add' ? '⊕ ' : '⊖ ') + (this.locate(st.target, scope, subjT).loc ?? '◌'))
          break
        case 'delete': this.push(this.writes, '- ' + (elem(this.typeOf(st.e, scope, subjT)) ?? '◌')); break
        case 'emit': st.attrs.forEach(a => this.read(a.value, scope, subjT)); this.push(this.emits, st.port); break
        case 'fail': st.attrs.forEach(a => this.read(a.value, scope, subjT)); this.push(this.fails, st.name); break
        case 'use': {
          st.attrs.forEach(a => this.read(a.value, scope, subjT))
          const c = this.w.components.get(st.comp)
          if (c) this.block(c.node.children, new Map(), c.of)
          break
        }
      }
      this.block(n.children, inner, subjT)
    }
  }
}

export function shapeOf(w: World, sys: SystemDef): Shape {
  const s = new Shaper(w)
  s.block(sys.node.children, new Map(), sys.comp?.of)
  return { name: sys.name, on: sys.trigger, reads: s.reads, writes: s.writes, emits: s.emits, fails: s.fails, line: sys.node.line.no }
}

export function fmtShape(sh: Shape): string {
  const parts: string[] = []
  if (sh.reads.length) parts.push('reads ' + sh.reads.join(' · '))
  if (sh.writes.length) parts.push('writes ' + sh.writes.join('  '))
  if (sh.emits.length) parts.push('emits ' + sh.emits.join(' · '))
  if (sh.fails.length) parts.push('fails ' + sh.fails.join(' · '))
  return parts.join('   ')
}

// ── 가정 실행: 줄마다 결과 ──────────────────────────────

export type NoteKind = 'value' | 'ok' | 'bad' | 'shape' | 'run' | 'fail' | 'hole' | 'muted'
export interface Note { line: number; text: string; kind: NoteKind }

class Failed { constructor(public name: string, public attrs: string, public line: number) {} }

class Runner {
  notes = new Map<number, string[]>()
  effects: string[] = []
  envAt = new Map<number, Env>()
  constructor(public w: World, public ports: Map<string, V>) {}

  note(line: number, text: string) {
    const arr = this.notes.get(line) ?? []
    if (!arr.includes(text)) arr.push(text)
    this.notes.set(line, arr)
  }

  ev(e: Expr, env: Env) { return this.w.eval(e, { ...env, ports: this.ports }) }

  block(nodes: Node[], env: Env) {
    let skipElse = true
    for (const n of nodes) {
      const st = parseStmt(n)
      const no = n.line.no
      if (!this.envAt.has(no)) this.envAt.set(no, { subj: env.subj, vars: new Map(env.vars), ports: this.ports })
      switch (st.s) {
        case 'let': {
          const v = this.ev(st.e, env)
          env.vars!.set(st.name, v)
          this.note(no, `${st.name} = ${fmt(v)}`)
          break
        }
        case 'when': {
          const v = this.ev(st.e, env)
          const ok = truthy(v)
          this.note(no, ok ? '참' : '거짓')
          skipElse = ok
          if (ok) this.block(n.children, env)
          continue
        }
        case 'else':
          this.note(no, skipElse ? '건너뜀' : '실행')
          if (!skipElse) this.block(n.children, env)
          continue
        case 'for': {
          const xs = items(this.ev(st.e, env)) ?? []
          this.note(no, `${xs.length}번`)
          for (const x of xs) {
            const vars = new Map(env.vars)
            vars.set(st.name, x)
            this.block(n.children, { ...env, vars })
          }
          continue
        }
        case 'set': {
          const old = this.ev(st.target, env)
          const v = this.ev(st.e, env)
          this.note(no, `${fmt(old)} → ${fmt(v)}`)
          this.effects.push(`~ ${exprText(st.target)}`)
          break
        }
        case 'clear': {
          const old = this.ev(st.target, env)
          const empty = typeof old === 'string' ? '""' : Array.isArray(old) ? '[]' : isSet(old) ? '{}' : '∅'
          this.note(no, `${fmt(old)} → ${empty}`)
          this.effects.push(`~ ${exprText(st.target)}`)
          break
        }
        case 'create': {
          const o: Obj = { model: st.type, f: {} }
          st.attrs.forEach(a => { o.f[a.key] = this.ev(a.value, env) })
          this.note(no, `+ ${fmt(o)}`)
          this.effects.push(`+ ${st.type}`)
          break
        }
        case 'add': case 'remove': {
          const v = this.ev(st.e, env)
          this.note(no, `${st.s === 'add' ? '⊕' : '⊖'} ${fmt(v)}`)
          this.effects.push(`${st.s === 'add' ? '⊕' : '⊖'} ${exprText(st.target)}`)
          break
        }
        case 'delete': {
          const v = this.ev(st.e, env)
          this.note(no, `- ${fmt(v)}`)
          this.effects.push(`- ${isObj(v) ? v.model : '◌'}`)
          break
        }
        case 'emit': {
          const a = st.attrs.map(x => `${x.key}=${fmt(this.ev(x.value, env))}`).join(' ')
          this.note(no, `↗ ${st.port} ${a}`)
          this.effects.push(`↗ ${st.port}`)
          break
        }
        case 'fail': {
          const a = st.attrs.map(x => `${x.key}=${fmt(this.ev(x.value, env))}`).join(' ')
          this.note(no, `✗ ${st.name} ${a}`)
          throw new Failed(st.name, a, no)
        }
        case 'use': {
          const c = this.w.components.get(st.comp)
          const of = st.attrs.find(a => a.key === 'of')
          if (c) this.block(c.node.children, { vars: new Map(), subj: of ? this.ev(of.value, env) : undefined })
          break
        }
      }
      skipElse = true
      this.block(n.children, env)
    }
  }
}

function exprText(e: Expr): string {
  return e.t === 'path' ? e.text : e.t
}

// ── 전체 분석 ──────────────────────────────────────────

export interface Analysis {
  notes: Note[]; shapes: Shape[]; holes: string[]; expects: { ok: number; bad: number }
  w?: World; lines: Line[]; roots: Node[]
  /** 가정 실행 중 각 줄에 들어설 때의 주어·변수 (첫 반복 기준) */
  envAt: Map<number, Env>
}

export function analyze(doc: string): Analysis {
  const lines = splitLines(doc)
  const roots = outline(lines)
  const notes: Note[] = []
  const add = (line: number, text: string, kind: NoteKind) => notes.push({ line, text, kind })
  let w: World
  try { w = new World(roots) } catch (err) {
    return { notes: [{ line: 0, text: `분석 실패: ${(err as Error).message}`, kind: 'bad' }], shapes: [], holes: [], expects: { ok: 0, bad: 0 }, lines, roots, envAt: new Map() }
  }
  const expects = { ok: 0, bad: 0 }
  const envAt = new Map<number, Env>()

  const expect = (line: Line, actual: V) => {
    if (!line.expect?.length) return add(line.no, '→ ' + fmt(actual), 'value')
    const want = w.eval(parseExpr(line.expect), {})
    if (fmt(want) === fmt(actual)) { expects.ok++; add(line.no, `→ ${fmt(actual)} ✓`, 'ok') }
    else { expects.bad++; add(line.no, `→ ${fmt(actual)} ✗ 기대 ${fmt(want)}`, 'bad') }
  }

  // model: 계산 칸과 불변조건
  for (const def of w.models.values()) {
    const insts = def.single ? [w.singles.get(def.name)!] : w.instancesOf(def.name)
    for (const f of def.fields.values()) {
      if (!f.derived || !insts.length) continue
      const vals = insts.map(o => w.eval(f.derived!, { subj: o }))
      if (insts.length === 1) expect(f.line, vals[0])
      else add(f.line.no, '→ ' + insts.slice(0, 3).map((o, i) => (o.name ? `${o.name} ` : '') + fmt(vals[i])).join(' · '), 'value')
    }
    for (const c of def.checks) {
      if (!insts.length) continue
      const bad = insts.filter(o => !truthy(w.eval(c.e, { subj: o })))
      if (bad.length) add(c.line.no, `✗ ${bad.map(o => fmt(o)).join(', ')}`, 'bad')
      else add(c.line.no, `✓ ${insts.length}개 모두`, 'ok')
    }
  }

  // interface · component: 보간 문자열과 괄호 속성
  const showLine = (n: Node, subj: V | undefined) => {
    const m = n.line.main
    if (DECLS.has(n.head) || n.head === 'system') return
    const out: string[] = []
    m.forEach((l, i) => {
      if (l.k === 'str' && l.text.includes('{')) out.push(plain(w.eval(parseExpr([l]), { subj })))
      if (l.k === 'ident' && m[i + 1]?.text === '=' && m[i + 2]?.text === '(') {
        const p = new Parser(m.slice(i + 2))
        out.push(`${l.text}=${fmt(w.eval(p.primary(), { subj }))}`)
      }
    })
    if (out.length) add(n.line.no, '→ ' + out.join('  '), 'value')
  }
  for (const root of roots) {
    if (root.head === 'interface') walk(root, n => showLine(n, undefined))
    if (root.head === 'component') {
      const comp = w.components.get(root.line.main[1]?.text ?? '')
      const sample = comp?.of ? w.instancesOf(comp.of)[0] : undefined
      if (sample) add(root.line.no, `.  = ${fmt(sample)}`, 'muted')
      root.children.filter(c => c.head !== 'system').forEach(c => walk(c, n => showLine(n, sample)))
    }
  }

  // system: 모양 + (가정한 사건이면) 실행
  const shapes: Shape[] = []
  for (const sys of w.systems) {
    const sh = shapeOf(w, sys)
    shapes.push(sh)
    // 줄에는 무엇이 바뀌는지만. 전체 모양(reads 포함)은 옆 패널에
    let head = [sh.writes.join('  '), sh.emits.map(e => '↗ ' + e).join(' '), sh.fails.map(f => '✗ ' + f).join(' ')].filter(Boolean).join('   ')
    if (sys.assumed) {
      const ports = new Map<string, V>()
      sys.payload.forEach(a => ports.set(`${sys.trigger}.${a.key}`, w.eval(a.value, {})))
      const r = new Runner(w, ports)
      const subj = sys.comp?.of ? w.instancesOf(sys.comp.of)[0] : undefined
      let failed: Failed | undefined
      envAt.set(sys.node.line.no, { subj, vars: new Map(), ports })
      try { r.block(sys.node.children, { vars: new Map(), subj }) } catch (err) {
        if (err instanceof Failed) failed = err; else throw err
      }
      r.notes.forEach((texts, line) => add(line, texts.slice(0, 3).join(' · ') + (texts.length > 3 ? ' …' : ''), 'run'))
      r.envAt.forEach((v, k) => { if (!envAt.has(k)) envAt.set(k, v) })
      if (failed) add(sys.node.line.no, `↺ ${failed.name} 로 전부 되돌림`, 'fail')
      else if (!r.effects.length) add(sys.node.line.no, '○ 바뀐 것 없음', 'muted')
      else add(sys.node.line.no, `✓ 커밋`, 'ok')
    }
    if (head) add(sys.node.line.no, head, 'shape')
  }

  // 구멍
  const declared = collectDeclared(lines)
  const toks = classify(doc, declared)
  const holes: string[] = []
  for (const t of toks) {
    if (t.type !== 'hole') continue
    const name = doc.slice(t.from, t.to).split('.')[0]
    const line = lines.find(l => t.from >= l.from && t.from <= l.from + l.text.length)
    if (!holes.includes(name)) holes.push(name)
    if (line) add(line.no, `◌ ${name} 가 아직 없어요`, 'hole')
  }

  return { notes, shapes, holes, expects, w, lines, roots, envAt }
}
