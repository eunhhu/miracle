// 이름이 어디서 왔고, 어디서 바뀌고, 무슨 타입인지.
import { parse, walk, lastLineOf, fieldDefs, type Node, type Tree } from './parse'
import { Parser, type Arg, type E, type Pat, type TypeRef } from './expr'
import { lexLine } from './lex'
import { BUILTIN, autoStd, enableStd, stdModuleOf, type StdItem } from './std'
import {
  T, HOSTS, PRIMS, closest, fits, join, known, membersOf, memberTy, parseTy, resolve, show, subst, unwrapOpt, widen, isNum, isText,
  TypeSyntaxError, type Member, type Param, type Subst, type Ty, type TypeEnv,
} from './types'

export type SymKind = 'model' | 'field' | 'computed' | 'decl' | 'local' | 'param' | 'fn' | 'comp' | 'binder' | 'loop' | 'catch' | 'std' | 'builtin' | 'type' | 'case'

export interface Sym {
  id: number
  name: string
  kind: SymKind
  line: number
  from: number
  to: number
  type?: TypeRef
  node?: Node
  owner?: string
  doc?: string
  file?: string
  std?: StdItem
  /** 실패할 수 있다 (안에서 fail 하거나 실패할 수 있는 걸 부른다) */
  fails?: boolean
}
export interface Ref { from: number; to: number; sym: Sym; write?: boolean }
export interface Hole {
  from: number; to: number; msg: string
  fix?: { insert: string; at: number; label: string; to?: number }
  /** 뻔한 고침: 커서가 줄을 떠나면 에디터가 알아서 고친다 */
  auto?: boolean
}
export interface Block { node: Node; from: number; to: number; kind: string; name: string }
/** 식 하나의 타입 (점 뒤 자동완성 · 호버) */
export interface Typed { from: number; to: number; ty: Ty }

export interface Analysis {
  tree: Tree
  file?: string
  syms: Sym[]
  refs: Ref[]
  holes: Hole[]
  writes: Map<Sym, number[]>
  reads: Map<Sym, number[]>
  models: Map<string, Node>
  /** 고르기 model 의 경우: Circle → { node, owner: 'Shape' } */
  cases: Map<string, { node: Node; owner: string }>
  fns: Map<string, Node>
  decls: Map<string, Node>
  writable: Set<string>
  std: Map<string, StdItem>
  blocks: Block[]
  typed: Typed[]
  env: TypeEnv
  byPos: (pos: number) => Ref | undefined
  scopeAt: (line: number) => Sym[]
  /** 이 이름의 타입 (예전 모양: 이름 + 목록 여부) */
  typeOf: (s: Sym) => TypeInfo
  /** 이 이름의 타입 */
  tyOf: (s: Sym) => Ty
  /** 이 줄에서 이 식을 쓰면 무슨 타입인지 (입력 중인 글자에도 쓴다) */
  tyOfText: (src: string, line: number) => Ty
  /** 모델의 칸들 */
  fieldsOf: (model: string) => Sym[]
}

export type Resolve = (from: string | undefined, path: string) => { file: string; text: string } | undefined

export type TypeInfo = { name: string; list: boolean; ty: Ty; text: string } | undefined
const info = (t: Ty): TypeInfo => {
  if (!known(t)) return
  const r = resolve(unwrapOpt(t))
  const list = r.k === 'list'
  const base = list ? resolve(r.of) : r
  return { name: base.k === 'model' ? base.n : show(base), list, ty: t, text: show(t) }
}

const FN_KINDS = new Set(['fn', 'comp'])

export function analyze(doc: string, resolveFile?: Resolve, file?: string, depth = 0): Analysis {
  const tree = parse(doc)
  const syms: Sym[] = [], refs: Ref[] = [], holes: Hole[] = [], typed: Typed[] = []
  const writes = new Map<Sym, number[]>(), reads = new Map<Sym, number[]>()
  const models = new Map<string, Node>(), fns = new Map<string, Node>(), decls = new Map<string, Node>()
  const scopes: Map<number, Sym[]> = new Map()
  const tys = new Map<Sym, Ty>()
  const env: TypeEnv = { models: new Set(), aliases: new Map() }
  let id = 0
  /** 조용히: 타입만 알아내고 참조·구멍은 안 남긴다 */
  let quiet = 0
  const sym = (s: Omit<Sym, 'id'>) => { const x = { ...s, id: id++ }; syms.push(x); return x }
  const hole = (h: Hole) => { if (!quiet) holes.push(h) }
  const ref = (r: Ref) => { if (!quiet) refs.push(r) }

  // ── use ──
  const std = autoStd()
  const module = new Map<string, Sym>()
  const modelFields = new Map<string, Map<string, Sym>>()
  const cases = new Map<string, { node: Node; owner: string }>()
  for (const n of tree.roots) {
    if (n.kind !== 'use' || !n.use) continue
    if (n.use.path === 'std') { for (const [k, v] of enableStd(n.use.items)) std.set(k, v); continue }
    const r = resolveFile?.(file, n.use.path)
    if (!r) { hole({ from: n.line.from, to: n.line.from + n.line.text.length, msg: `'${n.use.path}' 파일을 못 찾았어` }); continue }
    if (depth > 4) continue
    const sub = analyze(r.text, resolveFile, r.file, depth + 1)
    for (const [k, v] of sub.models) models.set(k, v)
    for (const [k, v] of sub.fns) fns.set(k, v)
    for (const [k, v] of sub.decls) decls.set(k, v)
    for (const [k, v] of sub.cases) cases.set(k, v)
    for (const k of sub.env.models) env.models.add(k)
    for (const [k, v] of sub.env.aliases) env.aliases.set(k, v)
    for (const s of sub.syms) {
      if (s.line !== s.node?.no || !['model', 'decl', 'fn', 'comp', 'case'].includes(s.kind) || (s.node?.parent && s.kind !== 'case')) continue
      if (n.use.items !== '*' && !n.use.items.includes(s.name)) continue
      const imp = sym({ ...s, file: r.file })
      tys.set(imp, sub.tyOf(s))
      module.set(n.use.alias ? `${n.use.alias}.${s.name}` : s.name, imp)
      if (s.kind === 'model' || s.kind === 'case') {
        const fm = new Map<string, Sym>()
        for (const f of sub.syms) if (f.owner === s.name) { const x = sym({ ...f, file: r.file }); tys.set(x, sub.tyOf(f)); fm.set(f.name, x) }
        modelFields.set(s.name, fm)
      }
    }
  }

  // ── 맨 위 이름 ──
  for (const n of tree.roots) if (n.kind === 'model' && n.name) { models.set(n.name, n); if (!n.type) env.models.add(n.name) }
  for (const n of tree.roots) {
    if (n.kind === 'model' && n.name) {
      const s = sym({ name: n.name, kind: 'model', line: n.no, from: n.nameFrom!, to: n.nameFrom! + n.name.length, node: n })
      module.set(n.name, s)
      if (n.type) {
        // model Status = "pending" | "paid"   (별칭 · 고르기)
        env.aliases.set(n.name, tyRef(n.type, true))
        continue
      }
      const fm = new Map<string, Sym>()
      // model OutOfStock(product: Product) — 괄호가 곧 칸
      for (const p of n.params ?? []) fm.set(p.name, sym({ name: p.name, kind: 'field', line: n.no, from: p.from, to: p.to, type: p.type, node: n, owner: n.name }))
      for (const c of n.children) {
        if (c.kind === 'case' && c.name) {
          // 대문자 줄 = 경우: Circle(r: Number)
          module.set(c.name, sym({ name: c.name, kind: 'case', line: c.no, from: c.nameFrom!, to: c.nameFrom! + c.name.length, node: c, owner: n.name }))
          cases.set(c.name, { node: c, owner: n.name })
          const cf = new Map<string, Sym>()
          for (const p of c.params ?? []) cf.set(p.name, sym({ name: p.name, kind: 'field', line: c.no, from: p.from, to: p.to, type: p.type, node: c, owner: c.name }))
          // 길면 블록:  Rect\n    w: Number
          for (const f of c.children) if (f.kind === 'field' && f.name) cf.set(f.name, sym({ name: f.name, kind: 'field', line: f.no, from: f.nameFrom!, to: f.nameFrom! + f.name.length, type: f.type, node: f, owner: c.name }))
          modelFields.set(c.name, cf)
        }
        if ((c.kind === 'field' || c.kind === 'computed') && c.name)
          fm.set(c.name, sym({ name: c.name, kind: c.kind, line: c.no, from: c.nameFrom!, to: c.nameFrom! + c.name.length, type: c.type, node: c, owner: n.name }))
      }
      modelFields.set(n.name, fm)
    }
    if (n.kind === 'decl' && n.name) {
      decls.set(n.name, n)
      module.set(n.name, sym({ name: n.name, kind: 'decl', line: n.no, from: n.nameFrom!, to: n.nameFrom! + n.name.length, type: n.type, node: n }))
    }
    if (n.kind === 'fn' && n.name) {
      fns.set(n.name, n)
      const comp = /^[A-Z]/.test(n.name)
      module.set(n.name, sym({ name: n.name, kind: comp ? 'comp' : 'fn', line: n.no, from: n.nameFrom!, to: n.nameFrom! + n.name.length, node: n }))
    }
  }

  /** 적힌 타입 → Ty. 틀리면 그 자리에 구멍 */
  function tyRef(r: TypeRef | undefined, mark = false): Ty {
    if (!r) return T.unknown
    try {
      const t = parseTy(r.text, env)
      if (mark) {
        for (const m of r.text.matchAll(/[A-Z][\p{L}\p{N}_]*/gu)) {
          const s = module.get(m[0])
          if (s?.kind === 'model') { const at = r.from + rawIndex(r, m.index!); ref({ from: at, to: at + m[0].length, sym: s }) }
        }
      }
      return t
    } catch (e) {
      if (mark && e instanceof TypeSyntaxError) {
        const name = /'([^']+)'/.exec(e.message)?.[1]
        const at = name ? r.from + Math.max(0, rawIndex(r, r.text.indexOf(name))) : r.from
        const mod = name ? stdModuleOf(name) : undefined
        const sug = name ? closest(name, [...PRIMS, ...env.models, ...env.aliases.keys()]) : undefined
        hole({ from: at, to: name ? at + name.length : r.to, msg: e.message + (sug ? ` — ${sug}?` : mod ? '' : '') })
      }
      return T.unknown
    }
  }
  /** TypeRef.text 는 토큰을 붙여 만든 글자라 원문 위치와 다를 수 있다 → 대략 맞춘다 */
  function rawIndex(r: TypeRef, i: number) {
    const raw = doc.slice(r.from, r.to)
    const word = /^[\p{L}\p{N}_]+/u.exec(r.text.slice(i))?.[0]
    if (!word) return i
    const j = raw.indexOf(word, Math.max(0, i - 4))
    return j >= 0 ? j : raw.indexOf(word)
  }

  const stdSyms = new Map<string, Sym>()
  const stdSym = (name: string, it: StdItem) => {
    if (!stdSyms.has(name)) {
      const s = sym({ name, kind: it === BUILTIN[name] ? 'builtin' : 'std', line: -1, from: -1, to: -1, std: it, doc: it.doc, fails: it.fails })
      let t: Ty = T.unknown
      if (it.ty) { try { t = parseTy(it.ty, { models: new Set(), aliases: new Map() }) } catch { /* std 오타 */ } }
      if (it.fails && t.k === 'fn') t = { ...t, fails: true }
      tys.set(s, t)
      stdSyms.set(name, s)
    }
    return stdSyms.get(name)!
  }

  type Scope = { vars: Map<string, Sym>; up?: Scope }
  const top: Scope = { vars: module }
  const find = (sc: Scope | undefined, name: string): Sym | undefined => {
    for (let s = sc; s; s = s.up) { const v = s.vars.get(name); if (v) return v }
    const it = std.get(name) ?? BUILTIN[name]
    if (it) return stdSym(name, it)
  }
  const flat = (sc: Scope) => { const out: Sym[] = []; for (let s: Scope | undefined = sc; s; s = s.up) out.push(...s.vars.values()); return out }

  const mark = (m: Map<Sym, number[]>, s: Sym, line: number) => { if (quiet) return; const a = m.get(s) ?? []; if (!a.includes(line)) a.push(line); m.set(s, a) }

  // ── 이름의 타입 ──
  const busy = new Set<Sym>()
  function tyOfSym(s?: Sym): Ty {
    if (!s) return T.unknown
    const got = tys.get(s)
    if (got) return got
    if (busy.has(s)) return T.unknown
    busy.add(s)
    let t: Ty = T.unknown
    try {
      if (s.kind === 'model') t = env.aliases.get(s.name) ? { k: 'alias', n: s.name, of: env.aliases.get(s.name)! } : T.model(s.name)
      else if (s.kind === 'field') t = s.type ? tyRef(s.type) : T.unknown
      else if (s.kind === 'computed' && s.node?.value) { quiet++; t = widen(ex(s.node.value, top, s.line, s.owner ? T.model(s.owner) : undefined)); quiet-- }
      else if (s.kind === 'case' && s.node) {
        const ps: Param[] = fieldDefs(s.node).map(p => { const ty = tyRef(p.type); return { name: p.name, ty, opt: ty.k === 'opt' || !!p.value } })
        t = ps.length ? { k: 'fn', params: ps, ret: T.model(s.owner!) } : T.model(s.owner!)
      }
      else if (FN_KINDS.has(s.kind) && s.node) t = fnTy(s.node)
      else if (s.type) t = tyRef(s.type)
      else if (s.kind === 'decl' && s.node?.value) { quiet++; t = widen(ex(s.node.value, top, s.line)); quiet-- }
    } finally { busy.delete(s) }
    if (known(t)) tys.set(s, t)
    return t
  }

  const fnCache = new Map<Node, Ty>()
  function fnTy(n: Node): Ty {
    const c = fnCache.get(n)
    if (c) return c
    const params: Param[] = (n.params ?? []).map(p => { const ty = p.type ? tyRef(p.type) : T.unknown; return { name: p.name, ty, opt: ty.k === 'opt' } })
    let ret: Ty = n.type ? tyRef(n.type) : /^[A-Z]/.test(n.name ?? '') ? T.view : T.void
    if (!n.type && n.value) {
      const inner: Scope = { vars: new Map(), up: top }
      ;(n.params ?? []).forEach((p, i) => { const s = sym({ name: p.name, kind: 'param', line: n.no, from: p.from, to: p.to, type: p.type, node: n }); tys.set(s, params[i].ty); inner.vars.set(p.name, s) })
      fnCache.set(n, { k: 'fn', params, ret: T.unknown })
      quiet++; ret = widen(ex(n.value, inner, n.no)); quiet--
    } else if (!n.type && !/^[A-Z]/.test(n.name ?? '')) {
      // 마지막 줄이 값이면 그게 결과
      const last = n.children.filter(c => c.kind !== 'fn').at(-1)
      if (last?.kind === 'expr' && last.value) {
        const inner: Scope = { vars: new Map(), up: top }
        ;(n.params ?? []).forEach((p, i) => { const s = sym({ name: p.name, kind: 'param', line: n.no, from: p.from, to: p.to, type: p.type, node: n }); tys.set(s, params[i].ty); inner.vars.set(p.name, s) })
        fnCache.set(n, { k: 'fn', params, ret: T.unknown })
        quiet++; ret = widen(ex(last.value, inner, last.no)); quiet--
        if (!known(ret)) ret = T.void
      }
    }
    const t: Ty = { k: 'fn', params, ret, fails: fnFails(n) }
    fnCache.set(n, t)
    return t
  }
  function fnFails(n: Node): boolean {
    if (n.catches?.some(c => !c.pat)) return false
    let f = false
    for (const c of walk(n.children)) if (c.kind === 'fail') f = true
    return f
  }

  const fieldOf = (t: Ty, name: string): Sym | undefined => {
    const r = resolve(t)
    return r.k === 'model' ? modelFields.get(r.n)?.get(name) : undefined
  }

  const unknownName = (from: number, to: number, name: string, sc: Scope) => {
    const mod = stdModuleOf(name)
    if (mod) {
      const useLine = tree.roots.find(r => r.kind === 'use' && r.use?.path === 'std')
      hole({ from, to, msg: `'${name}' 는 ${mod} 화면 부품이야`, fix: useLine ? { insert: `, ${mod}.*`, at: useLine.line.from + useLine.line.text.lastIndexOf(']'), label: `use std.[${mod}.*] 추가` } : { insert: `use std.[${mod}.*]\n`, at: 0, label: `use std.[${mod}.*] 추가` } })
      return
    }
    const sug = closest(name, flat(sc).map(s => s.name).concat([...std.keys()]))
    hole({ from, to, msg: `'${name}' 가 뭔지 아직 없어` + (sug ? ` — ${sug}?` : ''), fix: sug ? { insert: sug, at: from, to, label: `${sug} 로 고치기` } : undefined })
  }

  const showGot = (t: Ty) => t.k === 'lit' ? `${show(t)} (${show(widen(t))})` : show(t)
  const mismatch = (e: E, got: Ty, want: Ty, where = '') => {
    const r = resolve(got)
    // 흔한 경우는 고치는 법까지
    let fix: Hole['fix']
    if (r.k === 'opt' && fits(r.of, want)) fix = { insert: ' ?? ‹기본값›'.replace(/‹|›/g, ''), at: e.to, label: '?? 기본값 붙이기' }
    else if (isText(want) && isNum(got)) fix = { insert: '.toText()', at: e.to, label: '.toText()' }
    else if (isNum(want) && isText(got) && r.k !== 'lit') fix = { insert: '.toNumber() ?? 0', at: e.to, label: '.toNumber() ?? 0' }
    const wantText = want.k === 'alias' && resolve(want).k === 'union' ? `${show(want)} (${show(resolve(want))})` : show(want)
    hole({ from: e.from, to: Math.max(e.to, e.from + 1), msg: `${where}${wantText} 자리인데 ${showGot(got)} 야`, fix })
  }

  /** 좁히기: if x 안에서는 x 가 none 이 아니다 */
  const narrow: Map<Sym, Ty>[] = []
  const narrowed = (s: Sym): Ty | undefined => { for (let i = narrow.length - 1; i >= 0; i--) { const t = narrow[i].get(s); if (t) return t } }

  const note = (e: E, ty: Ty) => { if (!quiet && known(ty)) typed.push({ from: e.from, to: e.to, ty }) }

  /** 식을 훑으며 참조를 남기고 타입을 돌려준다. expect: 받는 자리의 타입 (제네릭을 정할 때 쓴다) */
  function ex(e: E | undefined, sc: Scope, line: number, subj?: Ty, write = false, expect?: Ty): Ty {
    if (!e) return T.unknown
    const t = ex0(e, sc, line, subj, write, expect)
    note(e, t)
    return t
  }

  function ex0(e: E, sc: Scope, line: number, subj: Ty | undefined, write: boolean, expect?: Ty): Ty {
    switch (e.t) {
      case 'num': return e.unit ? T.dur : { k: 'lit', v: e.v }
      case 'str': {
        let plain = true
        for (const p of e.parts) if (typeof p !== 'string') { plain = false; ex(p, sc, line, subj) }
        return plain ? { k: 'lit', v: e.parts.join('') } : T.text
      }
      case 'time': return T.time
      case 'lit': return e.v === null ? T.none : T.bool
      case 'const': return T.text
      case 'bad': return T.unknown
      case 'name': {
        const s = find(sc, e.name)
        if (!s) { unknownName(e.from, e.to, e.name, sc); return T.unknown }
        ref({ from: e.from, to: e.to, sym: s, write })
        mark(write ? writes : reads, s, line)
        return narrowed(s) ?? tyOfSym(s)
      }
      case 'type': {
        const s = find(sc, e.name)
        if (s) { ref({ from: e.from, to: e.to, sym: s }); mark(reads, s, line); return tyOfSym(s) }
        if (!(PRIMS as string[]).includes(e.name)) unknownName(e.from, e.to, e.name, sc)
        return T.unknown
      }
      case 'subj': return subj ?? T.unknown
      case 'member': return member(e, sc, line, subj, write)
      case 'index': {
        const t = resolve(unwrapOpt(ex(e.obj, sc, line, subj)))
        const it = ex(e.idx, sc, line, subj)
        if (t.k === 'list') { if (known(it) && !isNum(it)) mismatch(e.idx, it, T.int, '목록 번호엔 '); return t.of }
        if (t.k === 'map') return T.opt(t.val)
        if (isText(t)) return T.text
        return T.unknown
      }
      case 'call': return call(e.fn, e.args, e, sc, line, subj, expect)
      case 'record': {
        // (name: "은후", cost: 3) — 받는 자리가 모델이면 그 모델로 맞춰 보고, 아니면 [Text: 값]
        const want = expect ? resolve(unwrapOpt(expect)) : undefined
        if (want?.k === 'model') {
          const fields = [...(modelFields.get(want.n)?.values() ?? [])].filter(f => f.kind === 'field')
          for (const f of e.fields) {
            const fs = fields.find(x => x.name === f.key)
            const vt = ex(f.value, sc, line, subj, false, fs ? tyOfSym(fs) : undefined)
            if (!fs) { hole({ from: f.value.from, to: f.value.to, msg: `${want.n} 에는 '${f.key}' 칸이 없어` }); continue }
            const ft = tyOfSym(fs)
            if (known(ft) && known(vt) && !fits(vt, ft)) mismatch(f.value, vt, ft, `${f.key} 엔 `)
          }
          for (const fs of fields) {
            const ft = tyOfSym(fs)
            if (!e.fields.some(f => f.key === fs.name) && resolve(ft).k !== 'opt' && resolve(ft).k !== 'list' && !fs.node?.value)
              hole({ from: e.from, to: e.to, msg: `${want.n} 의 ${fs.name} 가 빠졌어 (${show(ft)})` })
          }
          return T.model(want.n)
        }
        let vt: Ty = T.unknown
        for (const f of e.fields) vt = join(vt, widen(ex(f.value, sc, line, subj)))
        return { k: 'map', key: T.text, val: known(vt) ? vt : T.json }
      }
      case 'map': {
        const want = expect && resolve(expect).k === 'map' ? resolve(expect) as Extract<Ty, { k: 'map' }> : undefined
        let kt: Ty = T.unknown, vt: Ty = T.unknown
        for (const p of e.pairs) { kt = join(kt, widen(ex(p.k, sc, line, subj, false, want?.key))); vt = join(vt, widen(ex(p.v, sc, line, subj, false, want?.val))) }
        if (!e.pairs.length && want) return want
        return { k: 'map', key: known(kt) ? kt : T.text, val: vt }
      }
      case 'match': return matchTy(e, sc, line, subj, expect)
      case 'list': {
        let t: Ty = T.unknown
        const want = expect && resolve(expect).k === 'list' ? (resolve(expect) as any).of as Ty : undefined
        for (const i of e.items) t = join(t, ex(i, sc, line, subj, false, want))
        return T.list(widen(t))
      }
      case 'bin': {
        const l = ex(e.l, sc, line, subj), r = ex(e.r, sc, line, subj, false, e.op === '??' ? unwrapOpt(l) : undefined)
        if (e.op === '..' || e.op === '..<' || e.op === '..=') {
          for (const [side, t] of [[e.l, l], [e.r, r]] as const) if (known(t) && !isNum(t)) mismatch(side, t, T.int, `${e.op} 엔 `)
          if (e.op === '..') {
            const at = rangeOp(e)
            if (at >= 0) hole({ from: at, to: at + 2, msg: '끝을 넣는지 모양으로 적어줘: 0..<3 (3 빼고) · 0..=3 (3까지)', fix: { insert: '..<', at, to: at + 2, label: '..< 로 (끝 빼고)' } })
          }
          return T.list(T.int)
        }
        if (['==', '!=', '<', '>', '<=', '>='].includes(e.op)) return T.bool
        if (e.op === 'and' || e.op === 'or') return T.bool
        if (e.op === '??') {
          if (known(l) && resolve(l).k !== 'opt' && resolve(l).k !== 'none') hole({ from: e.l.from, to: e.l.to, msg: `${show(l)} 는 none 이 될 일이 없어서 ?? 가 필요 없어` })
          return join(unwrapOpt(l), r)
        }
        if (e.op === '+' && (isText(l) || isText(r))) return T.text
        if (e.op === '+' && resolve(l).k === 'list') return l
        if (known(l) && known(r)) {
          for (const [side, t] of [[e.l, l], [e.r, r]] as const) {
            if (resolve(t).k === 'opt') { hole({ from: side.from, to: side.to, msg: `없을 수도 있는 값(${show(t)})으로 계산하려 했어 — ?? 기본값을 붙여` }); return T.unknown }
            if (!isNum(t) && !(resolve(t).k === 'prim' && ['Duration', 'Time'].includes((resolve(t) as any).n))) { mismatch(side, t, T.num, `${e.op} 엔 `); return T.unknown }
          }
          const ints = [l, r].every(x => { const w = widen(resolve(x)); return w.k === 'prim' && w.n === 'Int' })
          return ints && e.op !== '/' ? T.int : T.num
        }
        return T.unknown
      }
      case 'un': { const t = ex(e.e, sc, line, subj); return e.op === 'not' ? T.bool : widen(t) }
      case 'pipe': ex(e.l, sc, line, subj); return ex(e.r, sc, line, subj)
      case 'spread': return ex(e.e, sc, line, subj)
      case 'cmd': return call(e.head, e.args, e, sc, line, subj, expect, true)
    }
  }

  function member(e: Extract<E, { t: 'member' }>, sc: Scope, line: number, subj: Ty | undefined, write: boolean): Ty {
    const ot = ex(e.obj, sc, line, subj, write)
    if (!known(ot)) return T.unknown
    let r = resolve(ot)
    let wrap = false
    if (r.k === 'opt' || r.k === 'none') {
      if (!e.opt) {
        hole({ from: e.obj.from, to: e.nameFrom + e.name.length, msg: `${src(e.obj)} 는 없을 수도 있어 — if ${src(e.obj)} 로 먼저 확인하거나 ${src(e.obj)}?.${e.name}`, fix: { insert: '?', at: e.nameFrom - 1, label: `?. 로 바꾸기` } })
      }
      if (r.k === 'none') return T.none
      r = resolve(r.of); wrap = true
    }
    const out = (t: Ty) => wrap ? T.opt(t) : t
    // 모델 칸
    if (r.k === 'model') {
      const f = fieldOf(r, e.name)
      if (f) { ref({ from: e.nameFrom, to: e.to, sym: f, write }); mark(write ? writes : reads, f, line); return out(tyOfSym(f)) }
      const names = [...(modelFields.get(r.n)?.keys() ?? [])]
      const sug = closest(e.name, names)
      hole({ from: e.nameFrom, to: e.to, msg: `${r.n} 에는 '${e.name}' 칸이 없어` + (sug ? ` — ${sug}?` : ''), fix: sug ? { insert: sug, at: e.nameFrom, to: e.to, label: `${sug} 로 고치기` } : undefined })
      return T.unknown
    }
    if (r.k === 'host') {
      const ft = HOSTS[r.n]?.fields[e.name]
      if (ft) return out(parseTy(ft, env))
      hole({ from: e.nameFrom, to: e.to, msg: `${r.n} 에는 '${e.name}' 가 없어 (${Object.keys(HOSTS[r.n]?.fields ?? {}).join(' · ')})` })
      return T.unknown
    }
    const { list, s } = membersOf(r)
    const m = list.find(x => x.name === e.name)
    if (m) {
      if (m.kind === 'method') {
        hole({ from: e.nameFrom, to: e.to, msg: `${e.name} 는 부르는 거야 — ${e.name}()`, fix: { insert: '()', at: e.to, label: '() 붙이기' } })
        return out(memberRet(m, s))
      }
      return out(memberTy(m, s))
    }
    // 모델 목록: cart.amount → 각 줄의 amount 들
    if (r.k === 'list') {
      const el = resolve(r.of)
      if (el.k === 'model') {
        const f = fieldOf(el, e.name)
        if (f) { ref({ from: e.nameFrom, to: e.to, sym: f, write }); mark(write ? writes : reads, f, line); return out(T.list(tyOfSym(f))) }
      }
    }
    noMember(r, e.name, e.nameFrom, e.to, list)
    return T.unknown
  }

  function noMember(r: Ty, name: string, from: number, to: number, list: Member[]) {
    const names = list.map(x => x.name)
    const r2 = resolve(r)
    if (r2.k === 'list' && resolve(r2.of).k === 'model') names.push(...(modelFields.get((resolve(r2.of) as any).n)?.keys() ?? []))
    const sug = closest(name, names)
    const elsewhere = Object.entries({ Text: T.text, Number: T.num, '목록': T.list(T.unknown) }).find(([, t]) => membersOf(t).list.some(m => m.name === name))?.[0]
    hole({
      from, to,
      msg: `${show(r)} 에는 '${name}' 가 없어` + (sug ? ` — ${sug}?` : elsewhere ? ` (${elsewhere} 에 있는 거야)` : ''),
      fix: sug ? { insert: sug, at: from, to, label: `${sug} 로 고치기` } : undefined,
    })
  }

  const memberRet = (m: Member, s: Subst) => { const t = memberTy(m, s); return t.k === 'fn' ? t.ret : t }

  function call(fn: E, args: Arg[], whole: E, sc: Scope, line: number, subj: Ty | undefined, expect?: Ty, cmd = false): Ty {
    // ── 값.메서드(…) ──
    if (fn.t === 'member') {
      const ot = ex(fn.obj, sc, line, subj)
      if (!known(ot)) { for (const a of args) ex(a.value, sc, line, T.unknown); return T.unknown }
      let r = resolve(ot), wrap = false
      if (r.k === 'opt') {
        if (!fn.opt) hole({ from: fn.obj.from, to: fn.nameFrom + fn.name.length, msg: `${src(fn.obj)} 는 없을 수도 있어 — if ${src(fn.obj)} 로 먼저 확인하거나 ${src(fn.obj)}?.${fn.name}(…)`, fix: { insert: '?', at: fn.nameFrom - 1, label: '?. 로 바꾸기' } })
        r = resolve(r.of); wrap = true
      }
      const { list, s } = membersOf(r)
      const m = list.find(x => x.name === fn.name)
      if (!m) {
        // 모델 칸이 함수일 수도 (드물다)
        const f = fieldOf(r, fn.name)
        if (f) { ref({ from: fn.nameFrom, to: fn.to, sym: f }); for (const a of args) ex(a.value, sc, line, subj); return T.unknown }
        noMember(r, fn.name, fn.nameFrom, fn.to, list)
        for (const a of args) ex(a.value, sc, line, T.unknown)
        return T.unknown
      }
      if (m.kind === 'prop') {
        hole({ from: fn.nameFrom, to: whole.to, msg: `${fn.name} 는 값이라 괄호 없이 읽어 — .${fn.name}` })
        return memberTy(m, s)
      }
      const ft = memberTy(m, s) as Extract<Ty, { k: 'fn' }>
      const ret = checkArgs(ft, args, sc, line, s, fn.name, m.each, r.k === 'list' ? r.of : undefined, expect)
      return wrap ? T.opt(ret) : ret
    }

    // ── 이름(…) ──
    let callee: Sym | undefined
    if (fn.t === 'name' || fn.t === 'type') callee = find(sc, fn.name)
    const ft = ex(fn, sc, line, subj)
    if (callee?.kind === 'model' || callee?.kind === 'case') {
      const made = T.model(callee.kind === 'case' ? callee.owner! : callee.name)
      const alias = env.aliases.get(callee.name)
      if (alias) { for (const a of args) ex(a.value, sc, line, subj); return T.unknown }
      // Product(name: "펜", price: 1000)
      const fields = (modelFields.get(callee.name) ? [...modelFields.get(callee.name)!.values()] : []).filter(f => f.kind === 'field')
      const params: Param[] = fields.map(f => { const t = tyOfSym(f); return { name: f.name, ty: t, opt: t.k === 'opt' || resolve(t).k === 'list' || !!f.node?.value } })
      for (const a of args) if (a.key && a.keyFrom !== undefined) { const f = fields.find(x => x.name === a.key); if (f) ref({ from: a.keyFrom, to: a.keyFrom + a.key.length, sym: f }) }
      checkArgs({ k: 'fn', params, ret: made }, args, sc, line, new Map(), callee.name)
      return made
    }
    const r = resolve(ft)
    if (r.k === 'fn') {
      if (callee?.fails) markFails(line)
      if (r.fails) markFails(line)
      // 줄 머리 부르기의 key=v 는 컴포넌트 · std 모두 이름으로 맞춘다
      return checkArgs(r, args, sc, line, new Map(), callee?.name ?? src(fn), undefined, undefined, expect, cmd && callee?.kind === 'comp')
    }
    if (r.k === 'view') { for (const a of args) tagArg(a, sc, line); return T.view }
    for (const a of args) ex(a.value, sc, line, subj, a.key === 'bind')
    return known(r) && !cmd && args.length ? (hole({ from: fn.from, to: fn.to, msg: `${show(r)} 는 부를 수 없어` }), T.unknown) : r.k === 'unknown' ? T.unknown : r
  }

  function tagArg(a: Arg, sc: Scope, line: number) {
    const t = ex(a.value, sc, line, undefined, a.key === 'bind')
    // onClick=copy(note.body) — 부르는 모양이면 '눌렀을 때 이걸 해' 로 읽는다 (화살표 함수 안 써도 됨)
    if (a.key && /^on[A-Z]/.test(a.key) && a.value.t === 'call') return
    if (a.key && /^on[A-Z]/.test(a.key) && known(t)) {
      const r = resolve(t)
      if (r.k !== 'fn') hole({ from: a.value.from, to: a.value.to, msg: `${a.key} 엔 함수를 줘 (지금은 ${show(t)})` })
    }
  }

  /** 인자 맞추기: 위치 · 이름 · 타입 · 빠진 것. 제네릭은 s 에 묶인다 */
  function checkArgs(ft: Extract<Ty, { k: 'fn' }>, args: Arg[], sc: Scope, line: number, s: Subst, who: string, eachAt?: number, elem?: Ty, expect?: Ty, comp = false): Ty {
    const s2: Subst = new Map(s)
    // 받는 자리의 타입으로 결과 제네릭을 먼저 정한다: users: User[] = get(…)
    if (expect && known(expect) && containsVar(ft.ret)) fits(expect, ft.ret, s2) || fits(ft.ret, expect, s2)
    const given = new Set<number>()
    let pos = 0
    for (const a of args) {
      let i = -1
      if (a.key) {
        i = ft.params.findIndex(p => p.name === a.key)
        if (i < 0) {
          const t = ex(a.value, sc, line, undefined, a.key === 'bind')
          if (comp || ft.params.some(p => p.name)) {
            if (a.key === 'bind' || /^on[A-Z]/.test(a.key) && !comp) continue
            const sug = closest(a.key, ft.params.map(p => p.name ?? ''))
            if (a.keyFrom !== undefined) hole({ from: a.keyFrom, to: a.keyFrom + a.key.length, msg: `${who} 은 '${a.key}' 를 받지 않아` + (sug ? ` — ${sug}?` : ` (${ft.params.map(p => p.name).join(' · ') || '받는 것 없음'})`) })
          }
          void t
          continue
        }
      } else {
        while (given.has(pos)) pos++
        i = pos++
        if (i >= ft.params.length) {
          ex(a.value, sc, line)
          hole({ from: a.value.from, to: a.value.to, msg: `${who} 은 ${ft.params.length}개만 받아` })
          continue
        }
      }
      given.add(i)
      const p = ft.params[i]
      const want = subst(p.ty, s2)
      let got: Ty
      const wr = resolve(want)
      if (i === eachAt && wr.k === 'fn' && !(a.value.t === 'name' && FN_KINDS.has(find(sc, a.value.name)?.kind ?? ''))) {
        // .qty > 0 처럼 항목마다 다시 계산하는 식
        const el = elem ?? (wr.params[0]?.ty ?? T.unknown)
        const rt = ex(a.value, sc, line, el)
        if (known(rt) && wr.ret.k === 'prim' && wr.ret.n === 'Bool' && !fits(rt, T.bool)) mismatch(a.value, rt, T.bool, '조건엔 ')
        if (containsVar(wr.ret)) fits(widen(rt), wr.ret, s2)
        continue
      }
      got = ex(a.value, sc, line, undefined, a.key === 'bind', want)
      if (known(got) && known(want) && !fits(got, want, s2)) mismatch(a.value, got, want, p.name ? `${p.name} 엔 ` : '')
    }
    // 빠진 것
    ft.params.forEach((p, i) => {
      if (given.has(i) || p.opt || resolve(p.ty).k === 'opt') return
      if (comp && resolve(p.ty).k === 'list') return
      const at = args.length ? args[args.length - 1].value.to : undefined
      hole({ from: at ?? (line >= 0 ? tree.lines[line]?.from ?? 0 : 0), to: (at ?? 0) + 1, msg: `${who} 에 ${p.name ?? `${i + 1}번째 값`}${p.name ? '=…' : ''} 가 필요해 (${show(p.ty)})` })
    })
    return subst(ft.ret, s2)
  }


  /** 갈래 모양을 확인하고 이름을 inner 에 묶는다. 경우 이름을 돌려준다 */
  function bindPat(p: Pat, an: Node, inner: Scope, owner?: string): string | undefined {
    if (p.k !== 'case') return
    const info = cases.get(p.name)
    const own = owner ? modelOrCases(owner) : []
    if (!info && !modelFields.has(p.name)) {
      const sug = closest(p.name, own.length ? own : [...cases.keys(), ...env.models])
      hole({ from: p.from, to: p.from + p.name.length, msg: `'${p.name}' 라는 경우가 없어` + (sug ? ` — ${sug}?` : ''), fix: sug ? { insert: sug, at: p.from, to: p.from + p.name.length, label: `${sug} 로 고치기` } : undefined })
    } else if (owner && own.length && info && info.owner !== owner) {
      hole({ from: p.from, to: p.from + p.name.length, msg: `${p.name} 는 ${owner} 의 경우가 아니야 (${own.join(' · ')})` })
    }
    const s0 = module.get(p.name)
    if (s0) ref({ from: p.from, to: p.from + p.name.length, sym: s0 })
    // 순서가 아니라 이름으로 받는다: Rect(h, w) 도 같은 칸
    const fm = modelFields.get(p.name)
    const names = [...(fm?.values() ?? [])].filter(f => f.kind === 'field').map(f => f.name)
    p.binds.forEach(b => {
      const f = fm?.get(b.name)
      if (!f && fm) {
        const sug = closest(b.name, names)
        hole({ from: b.from, to: b.to, msg: `${p.name} 에는 '${b.name}' 칸이 없어 (${names.join(', ') || '칸 없음'})`, fix: sug ? { insert: sug, at: b.from, to: b.to, label: `${sug} 로 고치기` } : undefined })
      }
      const s = sym({ name: b.name, kind: 'binder', line: an.no, from: b.from, to: b.to, node: an })
      tys.set(s, f ? tyOfSym(f) : T.unknown)
      inner.vars.set(b.name, s)
    })
    return p.name
  }
  /** a..b 에서 .. 의 위치 */
  const rangeOp = (e: Extract<E, { t: 'bin' }>) => {
    const ln = tree.lines.find(l => l.from <= e.l.to && e.l.to <= l.from + l.text.length)
    if (!ln) return -1
    const i = ln.text.indexOf('..', e.l.to - ln.from)
    return i < 0 ? -1 : ln.from + i
  }
  const modelOrCases = (m: string) => models.get(m)?.children.filter(c => c.kind === 'case').map(c => c.name!) ?? []
  const caseText = (c: string) => { const fs = [...(modelFields.get(c)?.keys() ?? [])]; return fs.length ? `${c}(${fs.join(', ')})` : c }

  /** match 값 — 갈래마다 타입을 모으고, 빠진 경우를 알려준다 */
  function matchTy(e: Extract<E, { t: 'match' }>, sc: Scope, line: number, subj: Ty | undefined, expect?: Ty): Ty {
    const st = ex(e.subj, sc, line, subj)
    const r = resolve(st)
    const owner = r.k === 'model' && modelOrCases(r.n).length ? r.n : undefined
    let out: Ty = T.unknown
    const seen = new Set<string>()
    let hasElse = false
    for (const arm of e.arms) {
      const an = arm.node as Node
      const inner: Scope = { vars: new Map(), up: sc }
      const p = arm.pat
      if (an.error) hole({ from: an.error.from, to: Math.max(an.error.to, an.error.from + 1), msg: an.error.msg })
      if (!p) continue
      if (p.k === 'else') hasElse = true
      else if (p.k === 'case') { const c = bindPat(p, an, inner, owner); if (c) seen.add(c) }
      else {
        const lt = ex(p.e, sc, an.no)
        if (known(st) && known(lt) && lt.k !== 'none' && !fits(lt, unwrapOpt(st))) mismatch(p.e, lt, st, '갈래: ')
        seen.add(show(lt))
      }
      scopes.set(an.no, flat(inner))
      const t = arm.body ? ex(arm.body, inner, an.no, subj, false, expect) : (block(an.children, inner, {}) ?? T.void)
      out = known(out) ? join(out, t) : t
    }
    if (!hasElse) {
      let missing: string[] = []
      if (owner) missing = modelOrCases(owner).filter(c => !seen.has(c)).map(caseText)
      else if (r.k === 'union' && r.of.every(x => x.k === 'lit')) missing = r.of.map(x => show(x)).filter(x => !seen.has(x))
      if (missing.length) {
        const lastArm = e.arms.at(-1)?.node as Node | undefined
        const ln = tree.lines[lastArm ? lastLineOf(lastArm) : line]
        const ind = ' '.repeat(lastArm ? lastArm.indent : (tree.lines[line]?.text.match(/^ */)?.[0].length ?? 0) + 2)
        hole({ from: e.from, to: e.from + 5, msg: `match 에 빠진 경우: ${missing.join(' · ')}`, fix: { insert: missing.map(m => `
${ind}${m}`).join(''), at: ln.from + ln.text.length, label: '빠진 갈래 채우기' } })
      }
    }
    return out
  }

  const failLines = new Set<number>()
  const markFails = (line: number) => { if (!quiet) failLines.add(line) }

  const src = (e: E) => doc.slice(e.from, e.to)

  function block(list: Node[], sc: Scope, ctx: Ctx): Ty {
    // 같은 몸통의 fn 은 미리 보인다
    for (const n of list) if (n.kind === 'fn' && n.name && sc !== top) {
      sc.vars.set(n.name, sym({ name: n.name, kind: /^[A-Z]/.test(n.name) ? 'comp' : 'fn', line: n.no, from: n.nameFrom!, to: n.nameFrom! + n.name.length, node: n }))
    }
    let last: Ty = T.void
    for (const n of list) last = stmt(n, sc, ctx) ?? T.void
    return last
  }

  type Ctx = { comp?: boolean; fnName?: string; ret?: Ty }

  /** 줄 끝 ? 예시 · ! 기대 도 이 자리의 타입에 맞아야 한다 */
  function exampleChecks(n: Node, sc: Scope, want?: Ty) {
    for (const [e, what] of [[n.ex, '예시'], [n.expect, '기대값']] as const) {
      if (!e) continue
      const t = ex(e, sc, n.no, undefined, false, want)
      if (want && known(want) && known(t) && !fits(t, want)) mismatch(e, t, want, `${what}: `)
    }
  }

  /** 줄 하나. 돌려주는 건 이 줄의 값 타입 (마지막 줄이 결과) */
  function stmt(n: Node, sc: Scope, ctx: Ctx): Ty | void {
    scopes.set(n.no, flat(sc))
    const L = n.no
    if (n.error) hole({ from: n.error.from, to: Math.max(n.error.to, n.error.from + 1), msg: n.error.msg })
    if (n.exArgs) for (const a of n.exArgs) ex(a.value, sc, L)
    switch (n.kind) {
      case 'model': {
        if (n.type) { tyRef(n.type, true); return }
        for (const p of n.params ?? []) tyRef(p.type, true)
        const subj = T.model(n.name!)
        for (const c of n.children) {
          scopes.set(c.no, flat(sc))
          if (c.error) hole({ from: c.error.from, to: c.error.to, msg: c.error.msg })
          if (c.kind === 'case') { for (const p of c.params ?? []) tyRef(p.type, true); for (const f of c.children) if (f.kind === 'field') tyRef(f.type, true) }
          if (c.kind === 'field') {
            const ft = tyRef(c.type, true)
            if (c.value) { const vt = ex(c.value, sc, c.no, undefined, false, ft); if (known(ft) && known(vt) && !fits(vt, ft)) mismatch(c.value, vt, ft, '기본값: ') }
            exampleChecks(c, sc, ft)
          }
          if (c.kind === 'computed' || c.kind === 'check') {
            const t = ex(c.value, sc, c.no, subj)
            if (c.kind === 'check' && known(t) && !fits(t, T.bool)) mismatch(c.value!, t, T.bool, 'check 엔 ')
            if (c.kind === 'computed' && c.expect) exampleChecks({ ...c, ex: undefined } as Node, { vars: new Map(), up: sc }, widen(t))
          }
        }
        return
      }
      case 'decl': {
        const want = n.type ? tyRef(n.type, true) : undefined
        const t = ex(n.value, sc, L, undefined, false, want)
        if (want && known(want) && known(t) && n.value && !fits(t, want)) mismatch(n.value, t, want)
        if (want && !n.value && known(want)) {
          const r = resolve(want)
          if (r.k !== 'opt' && r.k !== 'list' && r.k !== 'map' && !n.ex) hole({ from: n.nameFrom!, to: n.nameFrom! + n.name!.length, msg: `${n.name} 의 처음 값이 없어 — = 값 을 붙이거나 ${show(want)}? 로` })
        }
        exampleChecks(n, sc, want ?? (known(t) ? widen(t) : undefined))
        let s: Sym | undefined
        if (sc !== top) {
          s = sym({ name: n.name!, kind: 'local', line: L, from: n.nameFrom!, to: n.nameFrom! + n.name!.length, type: n.type, node: n })
          sc.vars.set(n.name!, s)
        } else s = module.get(n.name!)
        if (s && !tys.has(s)) tys.set(s, want && known(want) ? want : widen(t))
        return
      }
      case 'fn': {
        const ftype = fnTy(n) as Extract<Ty, { k: 'fn' }>
        const inner: Scope = { vars: new Map(), up: sc }
        ;(n.params ?? []).forEach((p, i) => {
          if (p.type) tyRef(p.type, true)
          const s = sym({ name: p.name, kind: 'param', line: L, from: p.from, to: p.to, type: p.type, node: n })
          tys.set(s, ftype.params[i]?.ty ?? T.unknown)
          inner.vars.set(p.name, s)
        })
        if (n.type) tyRef(n.type, true)
        if (n.value) {
          const t = ex(n.value, inner, L, undefined, false, n.type ? ftype.ret : undefined)
          if (n.type && known(ftype.ret) && known(t) && !fits(t, ftype.ret)) mismatch(n.value, t, ftype.ret, '돌려주는 값: ')
        }
        const comp = /^[A-Z]/.test(n.name ?? '')
        const bt = block(n.children, inner, { comp, fnName: n.name, ret: ftype.ret })
        // 마지막 줄이 결과
        const lastN = n.children.filter(c => c.kind !== 'fn').at(-1)
        if (n.type && !n.value && lastN && !comp && known(ftype.ret) && resolve(ftype.ret).k !== 'void' && lastN.kind !== 'fail') {
          const lf = lastN.line.from + lastN.indent, lt = lastN.line.from + lastN.line.text.length
          if (resolve(bt).k === 'void') hole({ from: lf, to: lt, msg: `마지막 줄이 결과야 — ${show(ftype.ret)} 값을 마지막 줄에 둬` })
          else if (known(bt) && !fits(bt, ftype.ret)) {
            if (lastN.kind === 'expr' && lastN.value) mismatch(lastN.value, bt, ftype.ret, '돌려주는 값: ')
            else hole({ from: lf, to: lt, msg: `돌려주는 값: ${show(ftype.ret)} 자리인데 ${showGot(bt)} 야` })
          }
        }
        for (const c of n.catches ?? []) {
          scopes.set(c.no, flat(inner))
          const cs: Scope = { vars: new Map(), up: inner }
          if (c.pat) bindPat(c.pat, c, cs)
          for (const b of c.binders ?? []) { const s = sym({ name: b.name, kind: 'catch', line: c.no, from: b.from, to: b.to, node: c }); tys.set(s, T.text); cs.vars.set(b.name, s) }
          block(c.children, cs, { fnName: n.name })
        }
        return
      }
      case 'for': {
        if (!n.binders) {
          // for 조건
          const ct = ex(n.cond, sc, L)
          if (known(ct) && !fits(ct, T.bool) && resolve(ct).k !== 'opt') mismatch(n.cond!, ct, T.bool, 'for 조건엔 ')
          block(n.children, { vars: new Map(), up: sc }, ctx)
          return
        }
        const t = ex(n.value, sc, L)
        const r = resolve(t)
        if (known(t) && r.k !== 'list' && r.k !== 'map') hole({ from: n.value!.from, to: n.value!.to, msg: `for 는 목록을 돌아 (지금은 ${show(t)})` })
        const inner: Scope = { vars: new Map(), up: sc }
        ;(n.binders ?? []).forEach((b, i) => {
          const s = sym({ name: b.name, kind: 'loop', line: L, from: b.from, to: b.to, node: n })
          // 목록: 항목, 번호 · 맵: 이름표, 값
          tys.set(s, r.k === 'list' ? (i ? T.int : r.of) : r.k === 'map' ? (i ? r.val : r.key) : T.unknown)
          inner.vars.set(b.name, s)
        })
        block(n.children, inner, ctx)
        return
      }
      case 'if': case 'else': {
        const nar = new Map<Sym, Ty>()
        if (n.cond) {
          const ct = ex(n.cond, sc, L)
          if (known(ct) && resolve(ct).k !== 'prim' && resolve(ct).k !== 'opt' && resolve(ct).k !== 'lit') { /* 목록 · 모델은 있다/없다 */ }
          collectNarrow(n.cond, sc, nar)
        }
        narrow.push(nar)
        const bt = block(n.children, { vars: new Map(), up: sc }, ctx)
        narrow.pop()
        if (n.elseNode) { const et = stmt(n.elseNode, sc, ctx) ?? T.void; return n.cond || n.kind === 'if' ? (resolve(bt).k === 'void' || resolve(et).k === 'void' ? T.void : join(bt, et)) : bt }
        return n.kind === 'else' && !n.cond ? bt : T.void
      }
      case 'assign': {
        if (ctx.comp) hole({ from: n.line.from + n.indent, to: n.line.from + n.line.text.length, msg: '화면을 그리는 중엔 못 바꿔. 안쪽 fn 으로 옮겨' })
        if (n.op === '=' && n.target?.t === 'name' && !find(sc, n.target.name)) {
          // 없는 이름에 = → 새로 만들려던 것. 타입은 값에서 알아내 한 번에 고친다
          const vt = widen(ex(n.value, sc, L))
          const tyText = known(vt) ? show(vt) : 'Type'
          hole({ from: n.target.from, to: n.target.to, msg: `'${n.target.name}' 는 처음 나와 — 만들려면 ${n.target.name}: ${tyText} = …`, fix: { insert: `: ${tyText}`, at: n.target.to, label: `${n.target.name}: ${tyText} 로 만들기` }, auto: known(vt) })
          const s = sym({ name: n.target.name, kind: sc === top ? 'decl' : 'local', line: L, from: n.target.from, to: n.target.to, node: n })
          tys.set(s, vt); sc.vars.set(n.target.name, s)
          return
        }
        const tt = ex(n.target, sc, L, undefined, true)
        const vt = ex(n.value, sc, L, undefined, false, n.op === '=' ? tt : undefined)
        if (known(tt) && known(vt) && n.value) {
          const r = resolve(tt)
          if (n.op === '=' && !fits(vt, tt)) mismatch(n.value, vt, tt)
          if (n.op === '+=' || n.op === '-=') {
            if (r.k === 'list') { if (n.op === '-=' ? !fits(vt, r.of) && !fits(vt, tt) : !fits(vt, r.of) && !fits(vt, tt)) mismatch(n.value, vt, r.of, '목록 항목엔 ') }
            else if (isText(tt) && n.op === '+=') { /* 글 이어 붙이기 */ }
            else if (!isNum(tt)) hole({ from: n.target!.from, to: n.target!.to, msg: `${show(tt)} 에는 ${n.op} 를 못 써` })
            else if (!isNum(vt)) mismatch(n.value, vt, tt)
          }
        }
        return
      }
      case 'fail': { const t = ex(n.value, sc, L); if (known(t) && !isText(t) && resolve(t).k !== 'model') mismatch(n.value!, t, T.text, 'fail 엔 '); return }
      case 'call': {
        const head = n.head
        const hs = head && (head.t === 'type' || head.t === 'name') ? find(sc, (head as any).name) : undefined
        const ct = head ? call(head, n.args ?? [], head, sc, L, undefined, undefined, true) : T.void
        void hs
        if (n.cond) ex(n.cond, sc, L)
        const inner: Scope = { vars: new Map(), up: sc }
        for (const b of n.binders ?? []) {
          const s = sym({ name: b.name, kind: 'binder', line: L, from: b.from, to: b.to, type: b.type, node: n })
          tys.set(s, b.type ? tyRef(b.type, true) : T.unknown)
          inner.vars.set(b.name, s)
        }
        block(n.children, inner, ctx)
        if (n.elseNode) { scopes.set(n.elseNode.no, flat(sc)); block(n.elseNode.children, { vars: new Map(), up: sc }, ctx) }
        exampleChecks(n, sc)
        return n.cond || n.children.length ? T.void : ct
      }
      case 'expr': { const t = ex(n.value, sc, L); exampleChecks(n, sc); if (!n.match) block(n.children, sc, ctx); return t }
      case 'arm': case 'case': return
      default: block(n.children, sc, ctx)
    }
  }

  /** if x · if x != none · if a and b → 안에서는 none 이 아니다 */
  function collectNarrow(c: E, sc: Scope, out: Map<Sym, Ty>) {
    if (c.t === 'bin' && c.op === 'and') { collectNarrow(c.l, sc, out); collectNarrow(c.r, sc, out); return }
    let target: E | undefined
    if (c.t === 'name') target = c
    if (c.t === 'bin' && c.op === '!=' && c.r.t === 'lit' && c.r.v === null) target = c.l
    if (target?.t === 'name') {
      const s = find(sc, target.name)
      if (s) { const t = narrowed(s) ?? tyOfSym(s); if (resolve(t).k === 'opt') out.set(s, unwrapOpt(t)) }
    }
  }

  block(tree.roots, top, {})


  // ✎: 어딘가에서 바꾸는 맨 위 이름
  const writable = new Set<string>()
  for (const [s, ls] of writes) if ((s.kind === 'decl' || s.kind === 'local') && ls.length) writable.add(s.name)

  const blocks: Block[] = tree.roots.map(n => ({
    node: n, from: n.no, to: lastLineOf(n), kind: n.kind,
    name: n.name ?? (n.head && 'name' in n.head ? (n.head as any).name : n.kind),
  }))

  const scopeAt = (line: number) => {
    for (let l = line; l >= 0; l--) { const s = scopes.get(l); if (s) return s }
    return [...module.values()]
  }

  refs.sort((a, b) => a.from - b.from)
  typed.sort((a, b) => a.from - b.from || b.to - a.to)
  return {
    tree, file, syms, refs, holes, writes, reads, models, cases, fns, decls, writable, std, blocks, typed, env,
    byPos: pos => refs.find(r => pos >= r.from && pos <= r.to),
    typeOf: s => info(tyOfSym(s)),
    tyOf: tyOfSym,
    tyOfText: (text, line) => {
      try {
        const toks = lexLine(text).filter(t => t.k !== 'comment')
        if (!toks.length) return T.unknown
        const p = new Parser(toks)
        const e = p.expr()
        const vars = new Map<string, Sym>()
        for (const s of scopeAt(line).slice().reverse()) vars.set(s.name, s)
        quiet++
        try { return ex(e, { vars, up: top }, line) } finally { quiet-- }
      } catch { return T.unknown }
    },
    fieldsOf: m => [...(modelFields.get(m)?.values() ?? [])],
    scopeAt,
  }
}

function containsVar(t: Ty): boolean {
  switch (t.k) {
    case 'var': return true
    case 'list': case 'opt': return containsVar(t.of)
    case 'map': return containsVar(t.key) || containsVar(t.val)
    case 'union': return t.of.some(containsVar)
    case 'fn': return t.params.some(p => containsVar(p.ty)) || containsVar(t.ret)
    default: return false
  }
}

export { walk }
