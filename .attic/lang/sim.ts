// 미리보기용 살아 있는 세계: 가정 값에서 출발해 사건을 실제로 일으키고 상태를 바꾼다.
// 사건 하나 = 트랜잭션 하나. fail 이나 check 위반이면 통째로 되돌린다.

import { World, parseStmt, fmt, isObj, items, isSet, truthyV, type Node, type Obj, type V, type Env, type SystemDef } from './analyze'
import { parseExpr, Parser, type Expr } from './expr'

export interface SimEvent { trigger: string; system: string; ok: boolean; fail?: string; changes: string[] }

class Fail { constructor(public name: string, public payload: Map<string, V>) {} }

export class Sim {
  w!: World
  log: SimEvent[] = []
  version = 0
  private subs = new Set<() => void>()

  constructor(private roots: Node[]) { this.reset() }

  reset() {
    this.w = new World(this.roots)
    this.log = []
    this.bump()
  }

  on(f: () => void) { this.subs.add(f); return () => this.subs.delete(f) }
  bump() { this.version++; this.subs.forEach(f => f()) }

  /** system 이 가정한 사건 값 (`on X ? path="c.txt"`) */
  payloadOf(sys: SystemDef): Map<string, V> {
    const m = new Map<string, V>()
    sys.payload.forEach(a => m.set(`${sys.trigger}.${a.key}`, this.w.eval(a.value, {})))
    return m
  }

  systemsFor(trigger: string) { return this.w.systems.filter(s => s.trigger === trigger) }

  /** 사건을 일으킨다. 이어지는 실패 사건까지 따라간다 */
  fire(trigger: string, subj?: V, payload?: Map<string, V>, depth = 0) {
    const systems = this.systemsFor(trigger)
    for (const sys of systems) {
      const ports = payload ?? this.payloadOf(sys)
      const snap = this.snapshot()
      const changes: string[] = []
      try {
        this.block(sys.node.children, { vars: new Map(), subj, ports }, changes)
        // 불변조건
        for (const def of this.w.models.values()) {
          const insts = def.single ? [this.w.singles.get(def.name)!] : this.w.instancesOf(def.name)
          for (const c of def.checks) for (const o of insts)
            if (!truthyV(this.w.eval(c.e, { subj: o }))) throw new Fail(`check ${def.name}`, new Map())
        }
        this.log.push({ trigger, system: sys.name, ok: true, changes })
      } catch (err) {
        if (!(err instanceof Fail)) throw err
        this.restore(snap)
        this.log.push({ trigger, system: sys.name, ok: false, fail: err.name, changes: [] })
        if (depth < 4) {
          const p = new Map<string, V>()
          err.payload.forEach((v, k) => p.set(`${sys.name}.fail.${k}`, v))
          this.fire(`${sys.name}.fail ${err.name}`, undefined, p, depth + 1)
          this.fire(`${sys.name}.fail`, undefined, p, depth + 1)
        }
      }
    }
    if (depth === 0) {
      if (!systems.length) this.log.push({ trigger, system: '', ok: true, changes: ['받는 system 없음'] })
      this.log = this.log.slice(-20)
      this.bump()
    }
  }

  setPort(key: string, v: V) { this.w.ports.set(key, v); this.bump() }

  // ── 실행 ──

  private ev(e: Expr, env: Env) { return this.w.eval(e, env) }

  private block(nodes: Node[], env: Env, ch: string[]) {
    let skipElse = true
    for (const n of nodes) {
      const st = parseStmt(n)
      switch (st.s) {
        case 'let': env.vars!.set(st.name, this.ev(st.e, env)); break
        case 'when': {
          const ok = truthyV(this.ev(st.e, env))
          skipElse = ok
          if (ok) this.block(n.children, env, ch)
          continue
        }
        case 'else':
          if (!skipElse) this.block(n.children, env, ch)
          skipElse = true
          continue
        case 'for': {
          const xs = [...(items(this.ev(st.e, env)) ?? [])]
          for (const x of xs) {
            const vars = new Map(env.vars)
            vars.set(st.name, x)
            this.block(n.children, { ...env, vars }, ch)
          }
          skipElse = true
          continue
        }
        case 'set': {
          const old = this.ev(st.target, env)
          const v = this.ev(st.e, env)
          this.assign(st.target, v, env)
          ch.push(`${text(st.target)}  ${fmt(old)} → ${fmt(v)}`)
          break
        }
        case 'clear': {
          const old = this.ev(st.target, env)
          const empty: V = typeof old === 'string' ? '' : Array.isArray(old) ? [] : isSet(old) ? { tag: 'set', items: [] } : null
          this.assign(st.target, empty, env)
          ch.push(`${text(st.target)}  비움`)
          break
        }
        case 'create': {
          const o: Obj = { model: st.type, f: {} }
          st.attrs.forEach(a => { o.f[a.key] = this.ev(a.value, env) })
          this.w.created.push(o)
          ch.push(`+ ${fmt(o)}`)
          break
        }
        case 'add': case 'remove': {
          const v = this.ev(st.e, env)
          const box = this.ev(st.target, env)
          const xs = Array.isArray(box) ? box : isSet(box) ? box.items : undefined
          if (!xs) break
          const at = xs.findIndex(x => x === v || (!isObj(v) && fmt(x) === fmt(v)))
          if (st.s === 'add' && !(isSet(box) && at >= 0)) xs.push(v)
          if (st.s === 'remove' && at >= 0) xs.splice(at, 1)
          ch.push(`${st.s === 'add' ? '⊕' : '⊖'} ${text(st.target)}  ${fmt(v)}`)
          break
        }
        case 'delete': {
          const v = this.ev(st.e, env)
          if (isObj(v)) { this.w.deleted.add(v); this.unlink(v); ch.push(`- ${fmt(v)}`) }
          break
        }
        case 'emit': {
          const a = st.attrs.map(x => `${x.key}=${fmt(this.ev(x.value, env))}`).join(' ')
          ch.push(`↗ ${st.port} ${a}`)
          break
        }
        case 'fail': {
          const p = new Map<string, V>()
          st.attrs.forEach(a => p.set(a.key, this.ev(a.value, env)))
          throw new Fail(st.name, p)
        }
        case 'use': {
          const c = this.w.components.get(st.comp)
          const of = st.attrs.find(a => a.key === 'of')
          if (c) this.block(c.node.children, { vars: new Map(), subj: of ? this.ev(of.value, env) : env.subj, ports: env.ports }, ch)
          break
        }
      }
      skipElse = true
    }
  }

  private assign(target: Expr, v: V, env: Env) {
    if (target.t !== 'path') return
    const segs = [...target.segs]
    let obj: V = null
    if (target.root === '.') obj = env.subj ?? null
    else if (env.vars?.has(target.root)) obj = env.vars.get(target.root)!
    else if (this.w.names.has(target.root)) obj = this.w.names.get(target.root)!
    else if (this.w.singles.has(target.root)) obj = this.w.singles.get(target.root)!
    else { this.w.ports.set(target.text, v); return }
    const last = segs.pop()
    if (last === undefined) { if (env.vars?.has(target.root)) env.vars.set(target.root, v); return }
    for (const s of segs) obj = this.w.field(obj, s)
    if (isObj(obj)) obj.f[last] = v
  }

  /** 지운 것을 모든 목록에서 뺀다 */
  private unlink(o: Obj) {
    const seen = new Set<unknown>()
    const visit = (v: V) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return
      seen.add(v)
      const xs = Array.isArray(v) ? v : isSet(v) ? v.items : undefined
      if (xs) { for (let i = xs.length - 1; i >= 0; i--) if (xs[i] === o) xs.splice(i, 1); xs.forEach(visit) }
      else if (isObj(v)) Object.values(v.f).forEach(visit)
    }
    this.w.names.forEach(visit); this.w.singles.forEach(visit); this.w.ports.forEach(visit); this.w.created.forEach(visit)
  }

  private snapshot() {
    const w = this.w
    return structuredClone({ names: w.names, singles: w.singles, ports: w.ports, created: w.created, deleted: w.deleted })
  }
  private restore(s: ReturnType<Sim['snapshot']>) {
    Object.assign(this.w, s)
  }
}

const text = (e: Expr) => e.t === 'path' ? e.text : e.t

export { parseExpr, Parser }
