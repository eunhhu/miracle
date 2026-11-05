// 타입: 모양으로 적고, 대부분은 추론한다.
//
//   Text Int Number Bool Time Duration Bytes Json   기본 값
//   T[]           목록              Line[]
//   T?            없을 수도 있음      Text?
//   [K: V]        이름표 → 값        [Text: Int]
//   A | B         둘 중 하나          "pending" | "paid"
//   (A, B) -> R   함수               (Product) -> Bool
//   T U K V ...   대문자 한 글자 = 아무 타입 (제네릭, 선언 없이)
//
// 메서드는 값의 타입에 붙어 있다. Text 에는 Text 메서드만, 목록에는 목록 메서드만.

export type Prim = 'Text' | 'Int' | 'Number' | 'Bool' | 'Time' | 'Duration' | 'Bytes' | 'Json'
export const PRIMS: Prim[] = ['Text', 'Int', 'Number', 'Bool', 'Time', 'Duration', 'Bytes', 'Json']
export const PRIM_DOC: Record<Prim, string> = {
  Text: '글자', Int: '정수', Number: '숫자 (소수 포함)', Bool: 'true · false', Time: '시각',
  Duration: '시간 길이 (5s · 3m · 2h)', Bytes: '바이트', Json: '아무 데이터 (모양 미정)',
}

export interface Param { name?: string; ty: Ty; opt?: boolean }
export type Ty =
  | { k: 'prim'; n: Prim }
  | { k: 'list'; of: Ty }
  | { k: 'opt'; of: Ty }
  | { k: 'map'; key: Ty; val: Ty }
  | { k: 'model'; n: string }
  | { k: 'alias'; n: string; of: Ty }
  | { k: 'lit'; v: string | number | boolean }
  | { k: 'union'; of: Ty[] }
  | { k: 'fn'; params: Param[]; ret: Ty; fails?: boolean }
  | { k: 'var'; n: string }
  | { k: 'host'; n: string }
  | { k: 'view' }
  | { k: 'none' }
  | { k: 'void' }
  | { k: 'unknown' }

export const T = {
  text: { k: 'prim', n: 'Text' } as Ty, int: { k: 'prim', n: 'Int' } as Ty, num: { k: 'prim', n: 'Number' } as Ty,
  bool: { k: 'prim', n: 'Bool' } as Ty, time: { k: 'prim', n: 'Time' } as Ty, dur: { k: 'prim', n: 'Duration' } as Ty,
  bytes: { k: 'prim', n: 'Bytes' } as Ty, json: { k: 'prim', n: 'Json' } as Ty,
  none: { k: 'none' } as Ty, void: { k: 'void' } as Ty, unknown: { k: 'unknown' } as Ty, view: { k: 'view' } as Ty,
  list: (of: Ty): Ty => ({ k: 'list', of }), opt: (of: Ty): Ty => of.k === 'opt' || of.k === 'unknown' ? of : ({ k: 'opt', of }),
  model: (n: string): Ty => ({ k: 'model', n }),
}

/** 이 파일에서 이름이 뜻하는 타입 (model · 별칭) */
export interface TypeEnv { models: Set<string>; aliases: Map<string, Ty>; hosts?: Set<string> }

// ── 적힌 타입 읽기 ──

export class TypeSyntaxError extends Error {}

export function parseTy(src: string, env: TypeEnv): Ty {
  const toks = src.match(/"(?:[^"\\]|\\.)*"|->|\[\]|\d+(?:\.\d+)?|[\p{L}_][\p{L}\p{N}_]*|\S/gu) ?? []
  let i = 0
  const peek = () => toks[i], next = () => toks[i++]
  const eat = (s: string) => { if (toks[i] !== s) throw new TypeSyntaxError(`타입에 '${s}' 가 필요해`); i++ }
  const union = (): Ty => {
    const parts = [post()]
    while (peek() === '|') { next(); parts.push(post()) }
    return parts.length === 1 ? parts[0] : { k: 'union', of: parts }
  }
  const post = (): Ty => {
    let t = atom()
    for (;;) {
      if (peek() === '[]') { next(); t = T.list(t) }
      else if (peek() === '[' && toks[i + 1] === ']') { i += 2; t = T.list(t) }
      else if (peek() === '?') { next(); t = T.opt(t) }
      else return t
    }
  }
  const atom = (): Ty => {
    const t = next()
    if (t === undefined) throw new TypeSyntaxError('타입이 비었어')
    if (t.startsWith('"')) return { k: 'lit', v: t.slice(1, -1) }
    if (/^\d/.test(t)) return { k: 'lit', v: Number(t) }
    if (t === 'true' || t === 'false') return { k: 'lit', v: t === 'true' }
    if (t === 'none') return T.none
    if (t === '[') {
      const a = union()
      if (peek() === ':') { next(); const v = union(); eat(']'); return { k: 'map', key: a, val: v } }
      eat(']'); return T.list(a)
    }
    if (t === '(') {
      const params: Param[] = []
      while (peek() !== ')' && peek() !== undefined) {
        let name: string | undefined
        if (/^[\p{Ll}_]/u.test(peek()!) && toks[i + 1] === ':') { name = next(); next() }
        const ty = union()
        params.push({ name, ty, opt: ty.k === 'opt' })
        if (peek() === ',') next()
      }
      eat(')')
      if (peek() === '->') { next(); return { k: 'fn', params, ret: post() } }
      if (params.length === 1 && !params[0].name) return params[0].ty
      if (params.length === 0) return T.void
      throw new TypeSyntaxError('(…) 다음엔 -> 결과 타입')
    }
    if ((PRIMS as string[]).includes(t)) return { k: 'prim', n: t as Prim }
    if (t === 'Path' || t === 'Url' || t === 'Id') return T.text   // 예전 이름: 글자로 본다
    if (t === 'View') return T.view
    if (env.aliases.has(t)) return { k: 'alias', n: t, of: env.aliases.get(t)! }
    if (env.models.has(t)) return T.model(t)
    if (HOSTS[t]) return { k: 'host', n: t }
    if (/^[A-Z]$/.test(t)) return { k: 'var', n: t }
    throw new TypeSyntaxError(`'${t}' 타입이 없어`)
  }
  const out = union()
  if (i < toks.length) throw new TypeSyntaxError(`'${toks[i]}' 는 타입이 아니야`)
  return out
}

export function safeTy(src: string | undefined, env: TypeEnv): Ty {
  if (!src) return T.unknown
  try { return parseTy(src, env) } catch { return T.unknown }
}

// ── 보여주기 ──

export function show(t: Ty): string {
  switch (t.k) {
    case 'prim': return t.n
    case 'list': return (needParen(t.of) ? `(${show(t.of)})` : show(t.of)) + '[]'
    case 'opt': return (needParen(t.of) ? `(${show(t.of)})` : show(t.of)) + '?'
    case 'map': return `[${show(t.key)}: ${show(t.val)}]`
    case 'model': case 'alias': case 'host': return t.n
    case 'var': return t.n
    case 'lit': return typeof t.v === 'string' ? JSON.stringify(t.v) : String(t.v)
    case 'union': return t.of.map(show).join(' | ')
    case 'fn': return `(${t.params.map(p => (p.name ? p.name + ': ' : '') + show(p.ty)).join(', ')}) -> ${show(t.ret)}`
    case 'view': return '화면'
    case 'none': return 'none'
    case 'void': return '()'
    case 'unknown': return '?'
  }
}
const needParen = (t: Ty) => t.k === 'union' || t.k === 'fn'

// ── 맞는지 ──

export type Subst = Map<string, Ty>

export function resolve(t: Ty, s?: Subst): Ty {
  if (t.k === 'alias') return resolve(t.of, s)
  if (t.k === 'var' && s?.has(t.n)) return resolve(s.get(t.n)!, s)
  return t
}

export function subst(t: Ty, s: Subst): Ty {
  switch (t.k) {
    case 'var': return s.has(t.n) ? subst(s.get(t.n)!, s) : t
    case 'list': return T.list(subst(t.of, s))
    case 'opt': return T.opt(subst(t.of, s))
    case 'map': return { k: 'map', key: subst(t.key, s), val: subst(t.val, s) }
    case 'union': return { k: 'union', of: t.of.map(x => subst(x, s)) }
    case 'fn': return { ...t, params: t.params.map(p => ({ ...p, ty: subst(p.ty, s) })), ret: subst(t.ret, s) }
    default: return t
  }
}

export const isNum = (t: Ty) => { const r = resolve(t); return r.k === 'prim' && (r.n === 'Int' || r.n === 'Number') || r.k === 'lit' && typeof r.v === 'number' }
export const isText = (t: Ty) => { const r = resolve(t); return r.k === 'prim' && r.n === 'Text' || r.k === 'lit' && typeof r.v === 'string' }
export const known = (t: Ty) => resolve(t).k !== 'unknown'

/** 리터럴은 넓혀서 기억한다: "펜" → Text, 3 → Int */
export function widen(t: Ty): Ty {
  if (t.k === 'lit') return typeof t.v === 'string' ? T.text : typeof t.v === 'boolean' ? T.bool : Number.isInteger(t.v) ? T.int : T.num
  if (t.k === 'list') return T.list(widen(t.of))
  return t
}

/** src 값을 dst 자리에 넣어도 되나. 제네릭 변수는 s 에 묶인다. */
export function fits(src: Ty, dst: Ty, s: Subst = new Map()): boolean {
  const a = src.k === 'alias' ? resolve(src) : src
  const b = dst.k === 'alias' ? resolve(dst) : dst
  if (a.k === 'unknown' || b.k === 'unknown') return true
  if (b.k === 'var') {
    if (s.has(b.n)) return fits(a, s.get(b.n)!, s)
    if (a.k !== 'none') s.set(b.n, widen(a))
    return true
  }
  if (a.k === 'var') { if (s.has(a.n)) return fits(s.get(a.n)!, b, s); return true }
  if (b.k === 'prim' && b.n === 'Json') return a.k !== 'fn' && a.k !== 'view'
  if (a.k === 'union') return a.of.every(x => fits(x, b, s))
  if (b.k === 'union') return b.of.some(x => fits(a, x, new Map(s))) && b.of.some(x => fits(a, x, s))
  if (b.k === 'opt') return a.k === 'none' || fits(a.k === 'opt' ? a.of : a, b.of, s)
  if (a.k === 'none') return b.k === 'void'
  if (a.k === 'opt') return false
  switch (b.k) {
    case 'prim':
      if (a.k === 'lit') return typeof a.v === 'string' ? b.n === 'Text' : typeof a.v === 'boolean' ? b.n === 'Bool' : (b.n === 'Number' || b.n === 'Int' && Number.isInteger(a.v) || b.n === 'Duration')
      return a.k === 'prim' && (a.n === b.n || a.n === 'Int' && b.n === 'Number' || a.n === 'Json')
    case 'lit': return a.k === 'lit' && a.v === b.v
    case 'list': return a.k === 'list' && fits(a.of, b.of, s)
    case 'map': return a.k === 'map' && fits(a.key, b.key, s) && fits(a.val, b.val, s)
    case 'model': return a.k === 'model' && a.n === b.n || a.k === 'prim' && a.n === 'Json'
    case 'host': return a.k === 'host' && a.n === b.n
    case 'fn': {
      if (a.k !== 'fn') return false
      const need = a.params.filter(p => !p.opt).length
      if (need > b.params.length) return false
      a.params.forEach((p, i) => { if (b.params[i]) fits(b.params[i].ty, p.ty, s) })
      return b.ret.k === 'void' || fits(a.ret, b.ret, s)
    }
    case 'view': return a.k === 'view'
    case 'void': return true
  }
  return false
}

/** 두 갈래 값의 타입 합치기 (if/else · ?? · 목록 항목) */
export function join(a: Ty, b: Ty): Ty {
  if (a.k === 'unknown') return b
  if (b.k === 'unknown') return a
  if (a.k === 'none') return T.opt(b)
  if (b.k === 'none') return T.opt(a)
  if (fits(a, b)) return b.k === 'lit' ? widen(b) : b
  if (fits(b, a)) return a.k === 'lit' ? widen(a) : a
  if (a.k === 'lit' && b.k === 'lit') return { k: 'union', of: [a, b] }
  if (a.k === 'union') return { k: 'union', of: [...a.of, b] }
  return { k: 'union', of: [a, b] }
}

export function unwrapOpt(t: Ty): Ty { const r = resolve(t); return r.k === 'opt' ? r.of : r }

// ── 플랫폼 값 (서버 요청 · 응답 등) ──

export const HOSTS: Record<string, { doc: string; fields: Record<string, string> }> = {
  Request: { doc: '들어온 HTTP 요청', fields: { method: 'Text', path: 'Text', query: '[Text: Text]', headers: '[Text: Text]', body: 'Json', ip: 'Text' } },
  File: { doc: '파일 (경로와 내용)', fields: { path: 'Text', name: 'Text', size: 'Int' } },
  Socket: { doc: '열려 있는 연결', fields: { url: 'Text', open: 'Bool' } },
}

// ── 타입에 붙은 칸 · 메서드 (분석 · 자동완성 · 실행이 같은 표를 쓴다) ──

export interface Member {
  name: string
  /** prop: 괄호 없이 읽는 값 · method: 괄호로 부르는 것 */
  kind: 'prop' | 'method'
  /** 타입 (메서드는 함수 타입). T = 목록 항목, K/V = 이름표/값 */
  sig: string
  doc: string
  /** 인자 중 항목마다 다시 계산하는 식 (.qty > 0 처럼) 의 위치 */
  each?: number
  run: (self: any, args: any[], each: (i: number, x: any) => any) => any
}

const P = (name: string, sig: string, doc: string, run: Member['run']): Member => ({ name, kind: 'prop', sig, doc, run })
const M = (name: string, sig: string, doc: string, run: Member['run'], each?: number): Member => ({ name, kind: 'method', sig, doc, run, each })
const cmp = (a: any, b: any) => a < b ? -1 : a > b ? 1 : 0
const pad = (n: number) => String(n).padStart(2, '0')

export const MEMBERS: Record<'Text' | 'Num' | 'Time' | 'Duration' | 'Bytes' | 'list' | 'map', Member[]> = {
  Text: [
    P('length', 'Int', '글자 수', s => [...s].length),
    P('isEmpty', 'Bool', '비었나', s => s.length === 0),
    M('upper', '() -> Text', '대문자로', s => s.toUpperCase()),
    M('lower', '() -> Text', '소문자로', s => s.toLowerCase()),
    M('trim', '() -> Text', '앞뒤 공백 빼기', s => s.trim()),
    M('contains', '(part: Text) -> Bool', '이 글자가 들어 있나', (s, [p]) => s.includes(p)),
    M('startsWith', '(part: Text) -> Bool', '이걸로 시작하나', (s, [p]) => s.startsWith(p)),
    M('endsWith', '(part: Text) -> Bool', '이걸로 끝나나', (s, [p]) => s.endsWith(p)),
    M('split', '(by: Text) -> Text[]', '나누기', (s, [p]) => s.split(p)),
    M('replace', '(from: Text, to: Text) -> Text', '전부 바꾸기', (s, [a, b]) => s.split(a).join(b)),
    M('slice', '(from: Int, to: Int?) -> Text', '일부만', (s, [a, b]) => [...s].slice(a, b ?? undefined).join('')),
    P('chars', 'Text[]', '글자 하나씩', s => [...s]),
    M('at', '(i: Int) -> Text?', 'i번째 글자 (0부터)', (s, [i]) => [...s][i] ?? null),
    M('code', '(i: Int?) -> Int', '글자 번호 (유니코드)', (s, [i]) => [...s][i ?? 0]?.codePointAt(0) ?? 0),
    M('indexOf', '(part: Text) -> Int?', '처음 나오는 자리', (s, [p]) => { const i = s.indexOf(p); return i < 0 ? null : [...s.slice(0, i)].length }),
    M('toInt', '() -> Int?', '정수로 (안 되면 none)', s => /^-?\d+$/.test(s.trim()) ? parseInt(s, 10) : null),
    M('toNumber', '() -> Number?', '숫자로 (안 되면 none)', s => s.trim() !== '' && !isNaN(Number(s)) ? Number(s) : null),
  ],
  Num: [
    M('round', '(digits: Int?) -> Number', '반올림', (n, [d]) => d ? Math.round(n * 10 ** d) / 10 ** d : Math.round(n)),
    M('floor', '() -> Int', '내림', n => Math.floor(n)),
    M('ceil', '() -> Int', '올림', n => Math.ceil(n)),
    P('abs', 'Number', '절댓값', n => Math.abs(n)),
    M('clamp', '(min: Number, max: Number) -> Number', '범위 안으로', (n, [a, b]) => Math.min(b, Math.max(a, n))),
    M('format', '() -> Text', '읽기 좋게 (1,000)', n => n.toLocaleString('ko-KR')),
    M('toText', '() -> Text', '글자로', n => String(n)),
  ],
  Time: [
    P('year', 'Int', '연', t => new Date(t).getFullYear()), P('month', 'Int', '월', t => new Date(t).getMonth() + 1),
    P('day', 'Int', '일', t => new Date(t).getDate()), P('hour', 'Int', '시', t => new Date(t).getHours()),
    P('minute', 'Int', '분', t => new Date(t).getMinutes()),
    M('since', '(other: Time) -> Duration', '이 시각부터 지난 시간', (t, [o]) => (+new Date(t) - +new Date(o)) / 1000),
    M('add', '(d: Duration) -> Time', '시간 더하기', (t, [d]) => new Date(+new Date(t) + d * 1000).toISOString()),
    M('format', '(pattern: Text?) -> Text', '글자로 (기본 HH:mm)', t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }),
  ],
  Duration: [
    P('seconds', 'Number', '초', d => d), P('minutes', 'Number', '분', d => d / 60), P('hours', 'Number', '시간', d => d / 3600),
  ],
  Bytes: [
    P('size', 'Int', '바이트 수', b => b?.length ?? 0),
    M('toText', '() -> Text', 'UTF-8 글자로', b => typeof b === 'string' ? b : new TextDecoder().decode(b)),
  ],
  list: [
    P('count', 'Int', '개수', o => o.length),
    P('isEmpty', 'Bool', '비었나', o => o.length === 0),
    P('first', 'T?', '첫 항목 (없으면 none)', o => o[0] ?? null),
    P('last', 'T?', '마지막 항목 (없으면 none)', o => o[o.length - 1] ?? null),
    M('find', '(match: (T) -> Bool) -> T?', '조건에 맞는 첫 항목', (o, _, e) => o.find((x: any) => e(0, x)) ?? null, 0),
    M('filter', '(match: (T) -> Bool) -> T[]', '조건에 맞는 것만', (o, _, e) => o.filter((x: any) => e(0, x)), 0),
    M('map', '(to: (T) -> U) -> U[]', '하나씩 바꾸기', (o, _, e) => o.map((x: any) => e(0, x)), 0),
    M('sort', '() -> T[]', '작은 것부터 정렬 (숫자·글자·시간)', o => [...o].sort(cmp)),
    M('sortBy', '(key: (T) -> U) -> T[]', '이 기준으로 정렬', (o, _, e) => [...o].sort((a, b) => cmp(e(0, a), e(0, b))), 0),
    M('any', '(match: (T) -> Bool) -> Bool', '하나라도 맞나', (o, _, e) => o.some((x: any) => e(0, x)), 0),
    M('every', '(match: (T) -> Bool) -> Bool', '전부 맞나', (o, _, e) => o.every((x: any) => e(0, x)), 0),
    M('take', '(n: Int) -> T[]', '앞에서 n개', (o, [n]) => o.slice(0, n === Infinity || n == null ? undefined : n)),
    M('skip', '(n: Int) -> T[]', '앞에서 n개 빼고', (o, [n]) => o.slice(n)),
    M('contains', '(item: T) -> Bool', '들어 있나', (o, [v]) => o.some((x: any) => JSON.stringify(x) === JSON.stringify(v))),
    M('reverse', '() -> T[]', '거꾸로', o => [...o].reverse()),
    M('join', '(by: Text) -> Text', '이어 붙이기 (글자 목록)', (o, [b]) => o.join(b ?? '')),
  ],
  map: [
    P('count', 'Int', '개수', o => Object.keys(o).length),
    P('keys', 'K[]', '이름표들', o => Object.keys(o)),
    P('values', 'V[]', '값들', o => Object.values(o)),
    M('get', '(key: K) -> V?', '이 이름표의 값', (o, [k]) => o[k] ?? null),
    M('has', '(key: K) -> Bool', '이 이름표가 있나', (o, [k]) => k in o),
  ],
}

/** 이 타입의 값에 붙은 칸·메서드와, 그 안의 T/K/V 가 뜻하는 것 */
export function membersOf(t: Ty): { list: Member[]; s: Subst } {
  const r = resolve(t)
  if (r.k === 'prim') {
    if (r.n === 'Text') return { list: MEMBERS.Text, s: new Map() }
    if (r.n === 'Int' || r.n === 'Number') return { list: MEMBERS.Num, s: new Map() }
    if (r.n === 'Time') return { list: MEMBERS.Time, s: new Map() }
    if (r.n === 'Duration') return { list: MEMBERS.Duration, s: new Map() }
    if (r.n === 'Bytes') return { list: MEMBERS.Bytes, s: new Map() }
  }
  if (r.k === 'lit') return membersOf(widen(r))
  if (r.k === 'list') return { list: MEMBERS.list, s: new Map([['T', r.of]]) }
  if (r.k === 'map') return { list: MEMBERS.map, s: new Map([['K', r.key], ['V', r.val]]) }
  return { list: [], s: new Map() }
}

const sigCache = new Map<string, Ty>()
const NO_ENV: TypeEnv = { models: new Set(), aliases: new Map() }
export function memberTy(m: Member, s: Subst): Ty {
  let t = sigCache.get(m.sig)
  if (!t) { t = parseTy(m.sig, NO_ENV); sigCache.set(m.sig, t) }
  // U 는 부를 때마다 새로
  const s2 = new Map(s); s2.delete('U')
  return subst(t, s2)
}

/** 실행 쪽: 값의 모양으로 표를 고른다 */
export function membersOfValue(v: any): Member[] {
  if (Array.isArray(v)) return MEMBERS.list
  if (typeof v === 'string') return /^\d{4}-\d\d-\d\dT/.test(v) ? [...MEMBERS.Time, ...MEMBERS.Text] : MEMBERS.Text
  if (typeof v === 'number') return MEMBERS.Num
  if (v && typeof v === 'object' && !v.__t && !v.__fn) return MEMBERS.map
  return []
}

/** 비슷한 이름 (오타 안내용) */
export function closest(name: string, options: string[]): string | undefined {
  let best: string | undefined, bd = 3
  for (const o of options) { const d = dist(name.toLowerCase(), o.toLowerCase()); if (d < bd) { bd = d; best = o } }
  return best
}
function dist(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}
