// 에디터 안에서 실제로 돌리기. 바깥(get/post/now…)은 줄 끝 ? 예시로.
import type { Analysis } from './analyze'
import type { E, Arg, Pat, TypeRef } from './expr'
import { fieldDefs, walk, type Node } from './parse'
import { BUILTIN } from './std'
import { MEMBERS, membersOfValue } from './types'

export type V = any
export class Fail extends Error { constructor(readonly reason: V, readonly line?: number) { super(String(reason)) } }
class Respond { constructor(readonly status: number, readonly body: V, readonly attrs: Record<string, V>) {} }
class Stop {}

export interface FnRef { __fn: true; node: Node; scope: Scope; inst?: string; thunk?: () => V }
export interface Cell { get(): V; set(v: V): void; line?: number }
export class Scope {
  vars = new Map<string, Cell>()
  constructor(readonly up?: Scope) {}
  find(n: string): Cell | undefined { return this.vars.get(n) ?? this.up?.find(n) }
  let(n: string, v: V) { let x = v; this.vars.set(n, { get: () => x, set: y => { x = y } }) }
}

export interface VNode {
  tag: string
  comp?: string
  text?: string
  attrs: Record<string, V>
  events: Record<string, FnRef>
  bind?: Cell
  children: VNode[]
  line: number
  key: string
}

export interface LogEntry { kind: 'ok' | 'fail' | 'log' | 'response' | 'boundary'; text: string; line?: number; changes?: string[] }
export interface Route { method: string; path: string; node: Node; reqLine: Node }
export interface Source { node: Node; label: string; event: string; fn?: FnRef }

interface Ctx { subj?: V; line?: Node; inst?: string; usedEx?: Set<number>; render?: boolean }

const isRec = (v: V) => v && typeof v === 'object' && !Array.isArray(v) && !v.__fn
export const truthy = (v: V) => !(v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && v.length === 0))

export function eq(a: V, b: V): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]))
  if (isRec(a) && isRec(b)) {
    const ka = Object.keys(a).filter(k => a[k] !== null && a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== null && b[k] !== undefined)
    return ka.length === kb.length && ka.every(k => eq(a[k], b[k]))
  }
  return false
}

export function fmt(v: V, depth = 0): string {
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (depth > 2) return `[${v.length}]`
    const items = v.slice(0, 4).map(x => fmt(x, depth + 1))
    return `[${items.join(', ')}${v.length > 4 ? `, …+${v.length - 4}` : ''}]`
  }
  if (v.__fn) return `fn ${v.node.name}`
  if (isRec(v)) {
    if (depth > 2) return v.__t ? `${v.__t}(…)` : '(…)'
    const fields = Object.entries(v).filter(([k]) => !k.startsWith('__')).map(([k, x]) => `${k}: ${fmt(x, depth + 1)}`)
    return `${v.__t ?? ''}(${fields.join(', ')})`
  }
  return String(v)
}

export class World {
  globals = new Map<string, V>()
  locals = new Map<string, Map<string, V>>()
  version = 0
  log: LogEntry[] = []
  failLines = new Set<number>()
  /** native save/load (에디터 안에서만 기억) */
  saved = new Map<string, V>()
  routes: Route[] = []
  sources: Source[] = []
  mount?: Node
  module = new Scope()
  listeners = new Set<() => void>()
  private derivedGuard = new Set<string>()
  private lastResp = new Map<number, LogEntry>()

  constructor(readonly a: Analysis) {
    this.boot()
  }

  // ── 시작 ──
  boot() {
    const a = this.a
    const sc = this.module
    for (const [name, node] of a.fns) sc.vars.set(name, { get: () => ({ __fn: true, node, scope: sc }) as FnRef, set: () => {} })
    for (const [name, node] of a.decls) {
      const writable = a.writable.has(name)
      const hasBoundary = node.value ? this.mentionsBoundary(node.value) : false
      const derived = !writable && !hasBoundary && !!node.value && this.mentionsDecl(node.value)
      if (!derived) {
        let ready = false
        sc.vars.set(name, {
          line: node.no,
          get: () => {
            if (!ready) { ready = true; this.globals.set(name, this.initDecl(node, sc)) }
            return this.globals.get(name)
          },
          set: v => { ready = true; this.globals.set(name, v); this.version++ },
        })
      } else {
        sc.vars.set(name, {
          line: node.no,
          get: () => {
            if (this.derivedGuard.has(name)) throw new Fail(`'${name}' 가 자기 자신을 계산해`)
            this.derivedGuard.add(name)
            try { return node.ex && !hasBoundary ? this.ev(node.ex, sc, { line: node }) : this.ev(node.value!, sc, { line: node }) }
            finally { this.derivedGuard.delete(name) }
          },
          set: () => { throw new Fail(`'${name}' 는 계산 값이라 못 바꿔`) },
        })
      }
    }
    for (const [name] of a.decls) { try { sc.find(name)!.get() } catch { /* 렌즈에서 보임 */ } }
    // 바깥 일 찾기
    for (const n of a.tree.roots) {
      if (n.kind !== 'call' || n.head?.t !== 'name') continue
      const h = n.head.name
      if (h === 'mount' || h === 'app') this.mount = n
      if (h === 'serve') this.collectRoutes(n.children, '')
      const it = a.std.get(h)
      if (it?.kind === 'source') {
        const ev = (n.args ?? []).find(x => x.key?.startsWith('on'))
        let fn: FnRef | undefined
        try { fn = ev ? this.ev(ev.value, sc, { line: n }) : undefined } catch { /* 이름 없음 */ }
        const label = [h, ...(n.args ?? []).filter(x => !x.key).map(x => { try { return fmt(this.ev(x.value, sc, { line: n })) } catch { return '?' } })].join(' ')
        this.sources.push({ node: n, label, event: ev?.key ?? 'on', fn })
      }
    }
  }

  private collectRoutes(list: Node[], prefix: string) {
    for (const n of list) {
      if (n.kind !== 'call' || n.head?.t !== 'name' || n.head.name !== 'route') continue
      const pos = (n.args ?? []).filter(x => !x.key)
      let method = 'ANY', path = ''
      for (const p of pos) {
        if (p.value.t === 'const') method = p.value.v
        else if (p.value.t === 'str') path = p.value.parts.filter(x => typeof x === 'string').join('')
      }
      const sub = n.children.filter(c => c.kind === 'call' && c.head?.t === 'name' && c.head.name === 'route')
      if (sub.length && method === 'ANY') this.collectRoutes(n.children, prefix + path)
      else this.routes.push({ method, path: prefix + path, node: n, reqLine: n })
    }
  }

  private mentionsDecl(e: E): boolean {
    let hit = false
    const visit = (x: any) => {
      if (!x || typeof x !== 'object' || hit) return
      if (x.t === 'name' && this.a.decls.has(x.name)) { hit = true; return }
      for (const k in x) if (k !== 'from' && k !== 'to') { const v = x[k]; if (Array.isArray(v)) v.forEach(visit); else if (typeof v === 'object') visit(v) }
    }
    visit(e)
    return hit
  }

  private mentionsBoundary(e: E): boolean {
    let hit = false
    const visit = (x: any) => {
      if (!x || typeof x !== 'object' || hit) return
      if ((x.t === 'name') && this.a.std.get(x.name)?.kind === 'boundary') { hit = true; return }
      for (const k in x) if (k !== 'from' && k !== 'to') { const v = x[k]; if (Array.isArray(v)) v.forEach(visit); else if (typeof v === 'object') visit(v) }
    }
    visit(e)
    return hit
  }

  private initDecl(node: Node, sc: Scope): V {
    if (node.ex && !(node.value && this.mentionsBoundary(node.value))) return this.ev(node.ex, sc, { line: node })
    if (!node.value) return node.type?.list ? [] : null
    try { return this.ev(node.value, sc, { line: node, usedEx: new Set() }) } catch (e) {
      if (e instanceof Fail) { this.log.push({ kind: 'fail', text: `${node.name}: ${fmt(e.reason)}`, line: node.no }); return node.type?.list ? [] : null }
      throw e
    }
  }

  emit() { this.version++; for (const l of this.listeners) l() }

  // ── 식 ──
  ev(e: E, sc: Scope, ctx: Ctx = {}): V {
    switch (e.t) {
      case 'num': return e.unit === 's' ? e.v : e.unit === 'ms' ? e.v / 1000 : e.v
      case 'str': return e.parts.map(p => typeof p === 'string' ? p : fmt(this.ev(p, sc, ctx))).join('')
      case 'time': return e.v
      case 'lit': return e.v
      case 'const': return e.v
      case 'subj': return ctx.subj
      case 'name': return this.lookup(e.name, sc, e.from)
      case 'type': {
        const cs = this.a.cases.get(e.name)
        if (cs && !(cs.node.params ?? []).length) return { __t: e.name, __of: cs.owner }
        if (cs) return { __model: e.name }
        const m = this.a.models.get(e.name)
        if (m) return { __model: e.name }
        const c = sc.find(e.name)
        if (c) return c.get()
        throw new Fail(`'${e.name}' 가 없어`)
      }
      case 'member': {
        const o = this.ev(e.obj, sc, ctx)
        return this.member(o, e.name, e.opt, sc)
      }
      case 'index': {
        const o = this.ev(e.obj, sc, ctx), i = this.ev(e.idx, sc, ctx)
        return Array.isArray(o) ? o[i < 0 ? o.length + i : i] ?? null : o?.[i] ?? null
      }
      case 'call': return this.call(e.fn, e.args, sc, ctx)
      case 'cmd': return this.call(e.head, e.args, sc, ctx)
      case 'record': {
        const r: Record<string, V> = {}
        for (const f of e.fields) {
          if (f.value.t === 'spread') Object.assign(r, this.ev(f.value.e, sc, ctx))
          else r[f.key!] = this.ev(f.value, sc, ctx)
        }
        return r
      }
      case 'list': {
        const out: V[] = []
        for (const i of e.items) i.t === 'spread' ? out.push(...(this.ev(i.e, sc, ctx) ?? [])) : out.push(this.ev(i, sc, ctx))
        return out
      }
      case 'un': { const v = this.ev(e.e, sc, ctx); return e.op === 'not' ? !truthy(v) : -v }
      case 'bin': {
        if (e.op === 'and') return truthy(this.ev(e.l, sc, ctx)) && truthy(this.ev(e.r, sc, ctx))
        if (e.op === 'or') return truthy(this.ev(e.l, sc, ctx)) || truthy(this.ev(e.r, sc, ctx))
        const l = this.ev(e.l, sc, ctx)
        if (e.op === '??') return l ?? this.ev(e.r, sc, ctx)
        const r = this.ev(e.r, sc, ctx)
        switch (e.op) {
          case '==': return eq(l, r)
          case '!=': return !eq(l, r)
          case '<': return l < r
          case '>': return l > r
          case '<=': return l <= r
          case '>=': return l >= r
          case '+': return Array.isArray(l) ? [...l, ...(Array.isArray(r) ? r : [r])] : typeof l === 'string' || typeof r === 'string' ? fmt(l) + fmt(r) : l + r
          case '-': return Array.isArray(l) ? l.filter(x => !eq(x, r)) : l - r
          case '*': return l * r
          case '/': return l / r
          case '%': return l % r
          case '..': case '..<': case '..=': { const end = e.op === '..=' ? r + 1 : r; const out: number[] = []; for (let i = l; i < end && out.length < 1e6; i++) out.push(i); return out }
        }
        throw new Fail(`'${e.op}' 를 모르겠어`)
      }
      case 'pipe': {
        const l = this.ev(e.l, sc, ctx)
        if (e.r.t === 'call') return this.call(e.r.fn, [{ value: { t: 'lit', v: null, from: 0, to: 0 } as E }, ...e.r.args], sc, ctx, [l])
        return this.call(e.r, [], sc, ctx, [l])
      }
      case 'spread': return this.ev(e.e, sc, ctx)
      case 'map': {
        const r: Record<string, V> = {}
        for (const p of e.pairs) r[this.ev(p.k, sc, ctx)] = this.ev(p.v, sc, ctx)
        return r
      }
      case 'match': {
        const v = this.ev(e.subj, sc, ctx)
        for (const arm of e.arms) {
          const s = new Scope(sc)
          if (!this.patOk(arm.pat, v, s, ctx)) continue
          return arm.body ? this.ev(arm.body, s, { ...ctx, line: arm.node }) : this.run(arm.node.children, s, ctx)
        }
        throw new Fail(`match: ${fmt(v, 1)} 에 맞는 갈래가 없어`)
      }
      case 'bad': throw new Fail(e.msg)
    }
  }

  /** 갈래 모양이 맞나 — 맞으면 이름들을 s 에 묶는다 */
  patOk(p: Pat | undefined, v: V, s: Scope, ctx: Ctx = {}): boolean {
    if (!p || p.k === 'else') return true
    if (p.k === 'lit') return eq(v, this.ev(p.e, s, ctx))
    if (!isRec(v) || v.__t !== p.name) return false
    // 이름으로 받는다
    p.binds.forEach(b => s.let(b.name, v[b.name] ?? null))
    return true
  }

  lookup(name: string, sc: Scope, _at?: number): V {
    const c = sc.find(name)
    if (c) return c.get()
    if (name === 'all') return Infinity
    if (name === 'platform') return 'web'
    if (name === 'location') return { path: '/' }
    if (name === 'request') return { method: 'GET', path: '/', query: {}, headers: {}, body: null, ip: '127.0.0.1' }
    throw new Fail(`'${name}' 가 없어`)
  }

  member(o: V, name: string, opt: boolean | undefined, sc: Scope): V {
    if (o === null || o === undefined) {
      if (opt) return null
      throw new Fail(`none 의 '${name}' 를 읽으려 했어`)
    }
    if (Array.isArray(o)) {
      const m = MEMBERS.list.find(x => x.name === name && x.kind === 'prop')
      if (m) return m.run(o, [], () => null)
      return o.map(x => this.member(x, name, opt, sc))
    }
    if (!isRec(o) || !o.__t) {
      const m = membersOfValue(o).find(x => x.name === name)
      if (m && m.kind === 'prop') return m.run(o, [], () => null)
      if (m) return { __fn: true, __native: (args: V[]) => m.run(o, args, () => null) }
    }
    if (isRec(o)) {
      if (name in o) return o[name]
      const m = o.__t ? this.a.models.get(o.__t) : undefined
      const comp = m?.children.find(c => c.kind === 'computed' && c.name === name)
      if (comp) return this.ev(comp.value!, sc, { subj: o, line: comp })
      if (m && fieldDefs(m).some(f => f.name === name)) return null
    }
    throw new Fail(`'${name}' 칸이 없어`)
  }

  private args(args: Arg[], sc: Scope, ctx: Ctx) {
    const pos: V[] = [], named: Record<string, V> = {}
    for (const a of args) {
      if (a.key) named[a.key] = this.ev(a.value, sc, ctx)
      else if (a.value.t === 'spread') Object.assign(named, this.ev(a.value.e, sc, ctx))
      else pos.push(this.ev(a.value, sc, ctx))
    }
    return { pos, named }
  }

  call(fe: E, args: Arg[], sc: Scope, ctx: Ctx, pre: V[] = []): V {
    // 목록 메서드: 인자는 항목마다 다시 계산
    if (fe.t === 'member') {
      const o = this.ev(fe.obj, sc, ctx)
      const m = fe.name
      if (o === null || o === undefined) { if (fe.opt) return null; throw new Fail(`none 에서 ${m}() 를 부르려 했어`) }
      const mem = (isRec(o) && o.__t) ? undefined : membersOfValue(o).find(x => x.name === m && x.kind === 'method')
      if (mem) {
        const vals = args.map((a, i) => i === mem.each ? null : this.ev(a.value, sc, ctx))
        return mem.run(o, vals, (i, x) => args[i] ? this.ev(args[i].value, sc, { ...ctx, subj: x }) : x)
      }
      const f = this.member(o, m, false, sc)
      if (f?.__native) return f.__native(this.args(args, sc, ctx).pos)
      if (f?.__fn) return this.invoke(f, this.args(args, sc, ctx).pos, {})
      throw new Fail(`'${m}' 는 부를 수 없어`)
    }
    const { pos, named } = this.args(args.filter((_, i) => !(pre.length && i === 0 && fe.t !== 'type')), sc, ctx)
    const allPos = [...pre, ...pos]
    if (fe.t === 'type') {
      const cs = this.a.cases.get(fe.name)
      if (cs) return { ...this.construct(fe.name, cs.node, allPos, named, sc), __of: cs.owner }
      const m = this.a.models.get(fe.name)
      if (m) return this.construct(fe.name, m, allPos, named, sc)
      if (fe.name === 'File') return { __t: 'File', path: allPos[0] }
    }
    if (fe.t === 'name') {
      const c = sc.find(fe.name)
      if (c) {
        const f = c.get()
        if (f?.__fn) return this.invoke(f, allPos, named)
        if (f?.__model) return this.construct(f.__model, this.a.models.get(f.__model)!, allPos, named, sc)
        // 이름만 있는 줄 (함수의 마지막 줄 out 같은) = 그 값
        if (!args.length && !pre.length) return f
      }
      return this.std(fe.name, allPos, named, ctx)
    }
    const f = this.ev(fe, sc, ctx)
    if (f?.__fn) return this.invoke(f, allPos, named)
    throw new Fail('부를 수 없는 값이야')
  }

  construct(name: string, m: Node, pos: V[], named: Record<string, V>, sc: Scope): V {
    const r: Record<string, V> = { __t: name }
    const fields = fieldDefs(m)
    fields.forEach((f, i) => { r[f.name] = f.name in named ? named[f.name] : pos[i] !== undefined ? pos[i] : f.value ? this.ev(f.value, sc, { line: m }) : (f.type?.list ? [] : null) })
    for (const k of Object.keys(named)) if (!fields.some(f => f.name === k)) throw new Fail(`${name} 에는 '${k}' 칸이 없어`)
    return r
  }

  /** 줄 끝 ? 예시 = 이 줄이 바깥에서 받는 값 */
  private boundary(name: string, ctx: Ctx, fallback: () => V, what: string): V {
    const line = ctx.line
    if (line && this.failLines.has(line.no)) throw new Fail(`${what} 실패 (에디터에서 실패로 둠)`, line.no)
    const used = ctx.usedEx ?? new Set<number>()
    const first = line?.line.body.find(t => t.k === 'ident' && this.a.std.get(t.text)?.kind === 'boundary')?.text
    if (line && (line.ex || line.exArgs) && !used.has(line.no) && (!first || first === name)) {
      used.add(line.no)
      ctx.usedEx = used
      this.log.push({ kind: 'boundary', text: `${what} → 예시`, line: line.no })
      return line.ex ? this.ev(line.ex, this.module, { line }) : this.args(line.exArgs!, this.module, { line }).named
    }
    void name
    return fallback()
  }

  std(name: string, pos: V[], named: Record<string, V>, ctx: Ctx): V {
    const it = this.a.std.get(name) ?? BUILTIN[name]
    if (!it) throw new Fail(`'${name}' 가 없어`)
    switch (name) {
      case 'sum': return (pos[0] ?? []).reduce((a: number, b: number) => a + (b ?? 0), 0)
      case 'min': return (pos[0] ?? []).length ? Math.min(...pos[0]) : null
      case 'max': return (pos[0] ?? []).length ? Math.max(...pos[0]) : null
      case 'log': this.log.push({ kind: 'log', text: pos.map(x => fmt(x)).join(' '), line: ctx.line?.no }); return null
      case 'get': case 'post': case 'put': case 'del':
        return this.boundary(name, ctx, () => { throw new Fail(`${name.toUpperCase()} ${pos[0]}: 예시 응답이 없어 (줄 끝에 ? 값)`, ctx.line?.no) }, `${name.toUpperCase()} ${pos[0] ?? ''}`)
      case 'now': return this.boundary(name, ctx, () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }, 'now()')
      case 'read': return this.boundary(name, ctx, () => `<${pos[0]} 내용>`, `read ${pos[0]}`)
      case 'write': case 'append': case 'remove': case 'send': return this.boundary(name, ctx, () => null, `${name} ${pos[0] ?? ''}`)
      case 'readBytes': return this.boundary(name, ctx, () => new Uint8Array(), `readBytes ${pos[0]}`)
      case 'list': return this.boundary(name, ctx, () => [], `list ${pos[0]}`)
      case 'exists': return this.boundary(name, ctx, () => false, `exists ${pos[0]}`)
      case 'env': return this.boundary(name, ctx, () => null, `env ${pos[0]}`)
      case 'paste': return this.boundary(name, ctx, () => '', 'paste()')
      case 'load': return this.boundary(name, ctx, () => this.saved.get(pos[0]) ?? null, `load ${pos[0]}`)
      case 'save': this.saved.set(pos[0], pos[1]); this.log.push({ kind: 'boundary', text: `save ${pos[0]}`, line: ctx.line?.no }); return null
      case 'run': return this.boundary(name, ctx, () => { throw new Fail(`run ${pos[0]}: 예시 출력이 없어 (줄 끝에 ? 값)`, ctx.line?.no) }, `run ${pos[0]}`)
      case 'open': case 'notify': case 'copy': case 'title': case 'go':
        this.log.push({ kind: 'boundary', text: `${name} ${pos.map(x => fmt(x)).join(' ')}`, line: ctx.line?.no }); return null
      case 'platform': return 'web'
      case 'response': throw new Respond(pos[0] ?? 200, pos[1] ?? null, named)
      case 'File': return { __t: 'File', path: pos[0] }
    }
    if (it.kind === 'tag') throw new Fail(`'${name}' 는 화면 안에서만 써`)
    return null
  }

  // ── 실행 ──
  invoke(f: FnRef, pos: V[], named: Record<string, V>): V {
    if (f.thunk) return f.thunk()
    const n = f.node
    const sc = new Scope(f.scope)
    ;(n.params ?? []).forEach((p, i) => sc.let(p.name, p.name in named ? named[p.name] : pos[i] ?? null))
    const body = () => n.value && (!n.children.length || n.match) ? this.ev(n.value, sc, { line: n, inst: f.inst }) : this.run(n.children, sc, { inst: f.inst })
    if (!n.catches?.length) return body()
    const snap = this.snapshot()
    try { return body() }
    catch (e) {
      if (!(e instanceof Fail)) throw e
      // catch 가 있는 함수 = 되돌림 단위
      this.restore(snap)
      for (const c of n.catches) {
        const cs = new Scope(sc)
        if (!this.patOk(c.pat, e.reason, cs)) continue
        for (const b of c.binders ?? []) cs.let(b.name, e.reason)
        this.log.push({ kind: 'fail', text: `${n.name}: ${fmt(e.reason)} → 되돌리고 catch`, line: e.line ?? n.no })
        return this.run(c.children, cs, { inst: f.inst })
      }
      throw e
    }
  }

  run(list: Node[], sc: Scope, ctx: Ctx): V {
    let last: V = null
    for (const n of list) if (n.kind === 'fn' && n.name) sc.vars.set(n.name, { get: () => ({ __fn: true, node: n, scope: sc, inst: ctx.inst }) as FnRef, set: () => {} })
    for (const n of list) {
      const c: Ctx = { ...ctx, line: n, usedEx: new Set() }
      switch (n.kind) {
        case 'fn': case 'use': case 'model': break
        case 'decl': last = null; sc.let(n.name!, n.ex && !(n.value && this.mentionsBoundary(n.value)) ? this.ev(n.ex, sc, c) : n.value ? this.ev(n.value, sc, c) : null); break
        case 'assign': this.assign(n, sc, c); last = null; break
        case 'if': case 'else': {
          let b: Node | undefined = n
          while (b) {
            if (!b.cond || truthy(this.ev(b.cond, sc, c))) { last = this.run(b.children, new Scope(sc), ctx); break }
            b = b.elseNode
          }
          break
        }
        case 'for': this.each(n, sc, c, s => this.run(n.children, s, ctx)); last = null; break
        case 'fail': throw new Fail(n.value ? this.ev(n.value, sc, c) : '실패', n.no)
        case 'call': {
          if (n.cond && !truthy(this.ev(n.cond, sc, c))) break
          last = this.call(n.head!, n.args ?? [], sc, c)
          break
        }
        case 'expr': last = this.ev(n.value!, sc, c); break
        case 'bad': throw new Fail(n.error?.msg ?? '못 읽는 줄', n.no)
      }
    }
    return last
  }

  /** for 한 바퀴씩: 목록(항목, 번호) · 맵(이름표, 값) · 조건 */
  each(n: Node, sc: Scope, c: Ctx, f: (s: Scope, j: number) => void) {
    if (!n.binders) {
      let j = 0
      while (truthy(this.ev(n.cond!, sc, c))) {
        if (++j > 100000) throw new Fail('for 가 멈추지 않아 (10만 바퀴)', n.no)
        f(new Scope(sc), j)
      }
      return
    }
    const v = this.ev(n.value!, sc, c)
    const [a, b] = n.binders
    const pairs: [V, V][] = Array.isArray(v) ? v.map((x, i) => [x, i]) : isRec(v) && !v.__t ? Object.entries(v) : v == null ? [] : (() => { throw new Fail(`for 는 목록을 돌아 (${fmt(v, 1)})`, n.no) })()
    pairs.forEach(([x, i], j) => { const s = new Scope(sc); s.let(a.name, x); if (b) s.let(b.name, i); f(s, j) })
  }

  /** 바꿀 수 있는 자리 */
  lvalue(e: E, sc: Scope, ctx: Ctx): Cell {
    if (e.t === 'name') {
      const c = sc.find(e.name)
      if (!c) throw new Fail(`'${e.name}' 가 없어`)
      return { get: () => c.get(), set: v => { c.set(v); this.version++ } }
    }
    if (e.t === 'member') {
      return { get: () => this.member(this.ev(e.obj, sc, ctx), e.name, e.opt, sc), set: v => { const o = this.ev(e.obj, sc, ctx); if (!isRec(o)) throw new Fail(`'${e.name}' 를 바꿀 수 없어`); o[e.name] = v; this.version++ } }
    }
    if (e.t === 'index') {
      return { get: () => this.ev(e, sc, ctx), set: v => { const o = this.ev(e.obj, sc, ctx); o[this.ev(e.idx, sc, ctx)] = v; this.version++ } }
    }
    throw new Fail('여기엔 넣을 수 없어')
  }

  assign(n: Node, sc: Scope, ctx: Ctx) {
    const cell = this.lvalue(n.target!, sc, ctx)
    const v = this.ev(n.value!, sc, ctx)
    if (n.op === '=') return cell.set(v)
    const cur = cell.get()
    if (n.op === '+=') cell.set(Array.isArray(cur) ? [...cur, v] : typeof cur === 'string' ? cur + fmt(v) : (cur ?? 0) + v)
    else if (n.op === '-=') {
      if (Array.isArray(cur)) { const i = cur.findIndex(x => eq(x, v)); cell.set(i < 0 ? cur : [...cur.slice(0, i), ...cur.slice(i + 1)]) }
      else cell.set((cur ?? 0) - v)
    }
  }

  // ── 되돌리기 ──
  snapshot() { return structuredClone({ g: [...this.globals], l: [...this.locals].map(([k, m]) => [k, [...m]]) }) as { g: [string, V][]; l: [string, [string, V][]][] } }
  restore(s: ReturnType<World['snapshot']>) {
    const c = structuredClone(s)
    this.globals = new Map(c.g)
    this.locals = new Map(c.l.map(([k, m]) => [k, new Map(m)]))
    this.version++
  }

  /** 모델 check 를 상태 전체에 */
  verify() {
    const seen = new Set<V>()
    const visit = (v: V) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return
      seen.add(v)
      if (Array.isArray(v)) return v.forEach(visit)
      if (v.__t) {
        const m = this.a.models.get(v.__t)
        for (const c of m?.children ?? []) {
          if (c.kind !== 'check') continue
          let ok = true
          try { ok = truthy(this.ev(c.value!, this.module, { subj: v, line: c })) } catch { ok = false }
          if (!ok) throw new Fail(`${v.__t} 규칙 '${c.line.text.trim().replace(/^check\s+/, '')}' 이 깨져 (${fmt(v)})`, c.no)
        }
      }
      for (const k in v) visit(v[k])
    }
    for (const v of this.globals.values()) visit(v)
    for (const m of this.locals.values()) for (const v of m.values()) visit(v)
  }

  private describe(before: ReturnType<World['snapshot']>): string[] {
    const out: string[] = []
    const b = new Map(before.g)
    for (const [k, v] of this.globals) {
      const o = b.get(k)
      if (!eq(o, v)) out.push(Array.isArray(v) && Array.isArray(o) ? (o.length === v.length ? `${k} 안의 값 바뀜` : `${k} ${o.length}개 → ${v.length}개`) : `${k} ${fmt(o, 1)} → ${fmt(v, 1)}`)
    }
    return out
  }

  /** 사건 하나 = 트랜잭션 하나. 실패하면 전부 되돌린다 */
  act(label: string, f: () => V, line?: number): LogEntry {
    const snap = this.snapshot()
    let entry: LogEntry
    try {
      f()
      this.verify()
      const changes = this.describe(snap)
      entry = { kind: 'ok', text: label, line, changes }
    } catch (e) {
      if (!(e instanceof Fail)) { this.restore(snap); entry = { kind: 'fail', text: `${label}: ${String((e as Error)?.message ?? e)}`, line }; this.log.push(entry); this.emit(); return entry }
      this.restore(snap)
      entry = { kind: 'fail', text: `${label}: ${fmt(e.reason)} → 전부 되돌림`, line: e.line ?? line }
    }
    this.log.push(entry)
    this.emit()
    return entry
  }

  fire(f: FnRef, args: V[] = [], label?: string) {
    return this.act(label ?? `${f.node.name}()`, () => this.invoke(f, args, {}), f.node.no)
  }

  fireSource(s: Source) {
    if (!s.fn) return
    let payload: V[] = []
    if (s.node.ex) payload = [this.ev(s.node.ex, this.module, { line: s.node })]
    this.fire(s.fn, payload, `${s.label} → ${s.fn.node.name}(${payload.map(x => fmt(x, 1)).join(', ')})`)
  }

  // ── 서버 ──
  request(r: Route, wrong = false): LogEntry {
    const n = r.node
    const label = `${r.method} ${r.path}`
    let req: Record<string, V> = {}
    if (!wrong) {
      if (n.exArgs) req = this.args(n.exArgs, this.module, { line: n }).named
      else if (n.ex) req = { body: this.ev(n.ex, this.module, { line: n }) }
    }
    const sc = new Scope(this.module)
    let ok = true, why = ''
    for (const b of n.binders ?? []) {
      const v = req[b.name] ?? null
      const msg = this.shape(v, b.type)
      if (msg) { ok = false; why = `${b.name}: ${msg}` }
      sc.let(b.name, msg ? v : this.tag(v, b.type))
    }
    let entry!: LogEntry
    const body = ok ? n.children : n.elseNode?.children
    if (!body) {
      // 받는 모양이 틀리면 플랫폼이 알아서 422
      entry = { kind: 'response', text: `${label} → 422 ${why}`, line: n.no }
      this.log.push(entry); this.lastResp.set(n.no, entry); this.emit(); return entry
    }
    const snap = this.snapshot()
    try {
      this.run(body, sc, {})
      this.verify()
      entry = { kind: 'response', text: `${label} → 응답 없음`, line: n.no, changes: this.describe(snap) }
    } catch (e) {
      if (e instanceof Respond) {
        this.verify()
        entry = { kind: 'response', text: `${label}${ok ? '' : ` (${why})`} → ${e.status} ${fmt(e.body, 1)}`, line: n.no, changes: this.describe(snap) }
      } else if (e instanceof Fail) {
        this.restore(snap)
        entry = { kind: 'fail', text: `${label} → 500 ${fmt(e.reason)} (되돌림)`, line: e.line ?? n.no }
      } else throw e
    }
    this.log.push(entry); this.lastResp.set(n.no, entry); this.emit()
    return entry
  }
  lastResponse(line: number) { return this.lastResp.get(line) }

  /** 값이 이 타입 모양인가. 아니면 이유 */
  shape(v: V, t?: TypeRef, depth = 0): string | undefined {
    if (!t) return
    if (v === null || v === undefined) return t.opt ? undefined : '없어'
    if (t.list) { if (!Array.isArray(v)) return '목록이 아니야'; for (const x of v) { const m = this.shape(x, { ...t, list: false, opt: false }, depth + 1); if (m) return m } return }
    switch (t.name) {
      case 'Text': return typeof v === 'string' ? undefined : '글이 아니야'
      case 'Number': return typeof v === 'number' ? undefined : '숫자가 아니야'
      case 'Bool': return typeof v === 'boolean' ? undefined : '참/거짓이 아니야'
      case 'Time': return typeof v === 'string' ? undefined : '시각이 아니야'
    }
    const m = this.a.models.get(t.name)
    if (!m) return
    if (!isRec(v)) return `${t.name} 모양이 아니야`
    for (const f of fieldDefs(m)) {
      const msg = this.shape(v[f.name], f.type, depth + 1)
      if (msg) return `${f.name} ${msg}`
    }
    for (const c of m.children) {
      if (c.kind !== 'check') continue
      try { if (!truthy(this.ev(c.value!, this.module, { subj: v }))) return `규칙 ${c.line.text.trim()} 위반` } catch { return `규칙 ${c.line.text.trim()} 위반` }
    }
  }
  private tag(v: V, t?: TypeRef): V {
    if (!t || !this.a.models.has(t.name)) return v
    if (t.list && Array.isArray(v)) return v.map(x => this.tag(x, { ...t, list: false }))
    return isRec(v) ? { __t: t.name, ...v } : v
  }

  // ── 화면 ──
  render(list: Node[], sc: Scope, key: string): VNode[] {
    const out: VNode[] = []
    for (const n of list) if (n.kind === 'fn' && n.name) sc.vars.set(n.name, { get: () => ({ __fn: true, node: n, scope: sc, inst: key }) as FnRef, set: () => {} })
    let i = 0
    for (const n of list) {
      const k = `${key}/${i++}`
      const ctx: Ctx = { line: n, inst: key, render: true, usedEx: new Set() }
      try {
        switch (n.kind) {
          case 'decl': this.localState(n, sc, key); break
          case 'for': this.each(n, sc, ctx, (s, j) => out.push(...this.render(n.children, s, `${k}.${j}`))); break
          case 'if': case 'else': {
            let b: Node | undefined = n
            while (b) { if (!b.cond || truthy(this.ev(b.cond, sc, ctx))) { out.push(...this.render(b.children, new Scope(sc), k)); break } b = b.elseNode }
            break
          }
          case 'call': {
            if (n.cond && !truthy(this.ev(n.cond, sc, ctx))) break
            out.push(...this.element(n, sc, k, ctx))
            break
          }
          case 'expr': {
            const v = this.ev(n.value!, sc, ctx)
            out.push({ tag: '#text', text: fmt(v), attrs: {}, events: {}, children: [], line: n.no, key: k })
            break
          }
        }
      } catch (e) {
        if (e instanceof Fail) out.push({ tag: '#error', text: fmt(e.reason), attrs: {}, events: {}, children: [], line: n.no, key: k })
        else throw e
      }
    }
    return out
  }

  private localState(n: Node, sc: Scope, key: string) {
    let m = this.locals.get(key)
    if (!m) { m = new Map(); this.locals.set(key, m) }
    const mm = m
    if (!mm.has(n.name!)) {
      const v = n.ex && !(n.value && this.mentionsBoundary(n.value)) ? this.ev(n.ex, sc, { line: n }) : n.value ? this.ev(n.value, sc, { line: n, usedEx: new Set() }) : null
      mm.set(n.name!, v)
    }
    sc.vars.set(n.name!, { line: n.no, get: () => (this.locals.get(key) ?? mm).get(n.name!), set: v => { let cur = this.locals.get(key); if (!cur) { cur = new Map(); this.locals.set(key, cur) } cur.set(n.name!, v); this.version++ } })
  }

  private element(n: Node, sc: Scope, key: string, ctx: Ctx): VNode[] {
    const h = n.head!
    if (h.t === 'type') {
      const fnNode = this.a.fns.get(h.name)
      if (!fnNode) throw new Fail(`'${h.name}' 컴포넌트가 없어`)
      const { pos, named } = this.args(n.args ?? [], sc, ctx)
      const inst = `${key}:${h.name}`
      const s = new Scope(this.module)
      ;(fnNode.params ?? []).forEach((p, i) => s.let(p.name, p.name in named ? named[p.name] : pos[i] ?? null))
      return [{ tag: '#comp', comp: h.name, attrs: named, events: {}, children: this.render(fnNode.children, s, inst), line: n.no, key: inst }]
    }
    const name = (h as any).name as string
    const it = this.a.std.get(name)
    if (!it || it.kind !== 'tag') {
      // 화면 안의 보통 부르기 (log 등)
      this.call(h, n.args ?? [], sc, ctx)
      return []
    }
    const attrs: Record<string, V> = {}, events: Record<string, FnRef> = {}
    let bind: Cell | undefined
    const texts: string[] = []
    for (const a of n.args ?? []) {
      if (a.key === 'bind') { bind = this.lvalue(a.value, sc, ctx); continue }
      if (a.key?.startsWith('on')) {
        if (a.value.t === 'call') {
          // 부르는 모양: 지금 부르지 않고 이벤트 때 부른다
          const call = a.value, c = { ...ctx }
          events[a.key] = { __fn: true, node: { ...(ctx.line as Node), name: a.key, params: [] }, scope: sc, thunk: () => this.ev(call, sc, c) } as FnRef
          continue
        }
        const f = this.ev(a.value, sc, ctx); if (f?.__fn) events[a.key] = f; continue
      }
      if (a.key) attrs[a.key] = this.ev(a.value, sc, ctx)
      else if (a.value.t === 'name' && !sc.find(a.value.name)) attrs[a.value.name] = true
      else texts.push(fmt(this.ev(a.value, sc, ctx)))
    }
    return [{ tag: name, text: texts.join(' ') || undefined, attrs, events, bind, children: this.render(n.children, sc, key), line: n.no, key }]
  }

  renderApp(): VNode[] {
    if (!this.mount) return []
    return this.render(this.mount.children, new Scope(this.module), 'app')
  }

  /** 컴포넌트 하나를 실제로 쓰이는 곳의 값으로, 없으면 예시로 */
  renderComponent(name: string): { props: Record<string, V>; nodes: VNode[] }[] {
    const found: { props: Record<string, V>; nodes: VNode[] }[] = []
    const seek = (ns: VNode[]) => { for (const v of ns) { if (v.comp === name && found.length < 3) found.push({ props: v.attrs, nodes: v.children }); seek(v.children) } }
    try { seek(this.renderApp()) } catch { /* */ }
    if (found.length) return found
    const fnNode = this.a.fns.get(name)
    if (!fnNode) return []
    const props: Record<string, V> = {}
    for (const p of fnNode.params ?? []) props[p.name] = this.example(p.type)
    const s = new Scope(this.module)
    for (const [k, v] of Object.entries(props)) s.let(k, v)
    return [{ props, nodes: this.render(fnNode.children, s, `solo:${name}`) }]
  }

  /** 타입의 예시 값 (칸마다 ? 예시) */
  example(t?: TypeRef, depth = 0): V {
    if (!t) return null
    if (t.list) return [this.example({ ...t, list: false }, depth)]
    switch (t.name) { case 'Text': return '글'; case 'Number': return 0; case 'Bool': return false; case 'Time': return '12:00' }
    const m = this.a.models.get(t.name)
    if (!m || depth > 3) return null
    const r: Record<string, V> = { __t: t.name }
    for (const f of fieldDefs(m)) r[f.name] = f.ex ? this.ev(f.ex, this.module, { line: m }) : this.example(f.type, depth + 1)
    return r
  }

  /** ! 기대 확인 */
  expectations(): Map<number, { ok: boolean; got: string }> {
    const out = new Map<number, { ok: boolean; got: string }>()
    for (const n of walk(this.a.tree.roots)) {
      if (!n.expect) continue
      try {
        const want = this.ev(n.expect, this.module, { line: n })
        let got: V
        if (n.kind === 'decl') got = this.module.find(n.name!)!.get()
        else if (n.kind === 'computed' && n.parent?.name) got = this.member(this.example({ name: n.parent.name, list: false, opt: false, text: '', from: 0, to: 0 }), n.name!, false, this.module)
        else if (n.value) got = this.ev(n.value, this.module, { line: n })
        out.set(n.no, { ok: eq(got, want), got: fmt(got, 1) })
      } catch (e) { out.set(n.no, { ok: false, got: e instanceof Fail ? fmt(e.reason) : String(e) }) }
    }
    return out
  }

  /** 지금 이름의 값 (렌즈용) */
  peek(name: string): { ok: true; v: V } | { ok: false; why: string } {
    const c = this.module.find(name)
    if (!c) return { ok: false, why: '' }
    try { return { ok: true, v: c.get() } } catch (e) { return { ok: false, why: e instanceof Fail ? fmt(e.reason) : String(e) } }
  }
}

export { Stop }
