// 고르기 덱: 드롭다운 대신 커서 옆에서 도는 입체 카드 휠.
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'
import { Prec, StateEffect, StateField, type EditorState, type TransactionSpec } from '@codemirror/state'
import { live } from './live'
import { describe, KIND_WORD } from './lens'
import { MODULE_DOC, STD, stdModuleOf } from '../core/std'
import { KEYWORDS } from '../core/lex'
import type { Analysis } from '../core/analyze'
import { HOSTS, known, membersOf, memberTy, resolve, show, type Ty } from '../core/types'

export interface Item {
  label: string; kind: string; detail?: string; info?: string; insert: string; score?: number; tone: string
  /** 정렬 묶음: 작을수록 위 */
  rank?: number
  /** 넣을 때 이 자리부터 바꾼다 (x. → x?. 처럼) */
  at?: number
  /** 넣으면서 파일 맨 위에 use 도 넣는다 */
  use?: string
}

const ACTIONS: { label: string; info: string; text: string; words: string }[] = [
  { label: '상태', info: '바뀌는 값 하나', text: '‹name›: ‹Type› = ‹값›', words: 'state var 상태 값 변수' },
  { label: '모델', info: '데이터 모양', text: 'model ‹Name›\n  ‹field›: ‹Text›', words: 'model 모델 타입 데이터' },
  { label: '화면 조각', info: '대문자 fn = 컴포넌트', text: 'fn ‹Name›()\n  div\n    ‹text "…"›', words: 'component 컴포넌트 화면 조각' },
  { label: '하는 일', info: '소문자 fn = 동작', text: 'fn ‹name›()\n  ‹›', words: 'function fn 함수 동작 액션' },
  { label: '화면 붙이기', info: 'mount "#app"', text: 'mount "#app"\n  ‹App›', words: 'mount 화면 앱 render' },
  { label: '하나씩', info: 'for … in …', text: 'for ‹x› in ‹list›\n  ‹›', words: 'for loop 반복 하나씩 map' },
  { label: '조건', info: 'if …', text: 'if ‹cond›\n  ‹›', words: 'if 조건 만약' },
  { label: '실패하면', info: '되돌리고 여기로', text: 'catch ‹reason›\n  ‹›', words: 'catch 실패 에러 error' },
  { label: '서버', info: 'serve + route', text: 'serve port=‹8080›\n  route GET "‹/›"\n    response 200 ‹"hi"›', words: 'server 서버 http serve' },
  { label: '길', info: 'route … body: T', text: 'route ‹POST› "‹/path›"  ‹body›: ‹Type›\n  response 200 ‹body›\nelse\n  response 400 "모양이 틀렸어"', words: 'route 라우트 길 api' },
  { label: '가져오기', info: 'use …', text: 'use ‹std.[dom.*]›', words: 'use import 가져오기 std' },
]

interface Deck { items: Item[]; sel: number; from: number; to: number; slash: boolean }
const setDeck = StateEffect.define<Deck | null>()
const move = StateEffect.define<number>()
export const deckField = StateField.define<Deck | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setDeck)) return e.value
      if (e.is(move) && v) return { ...v, sel: (v.sel + e.value + v.items.length) % v.items.length }
    }
    if (v && tr.docChanged) return { ...v, from: tr.changes.mapPos(v.from), to: tr.changes.mapPos(v.to) }
    if (v && tr.selection && !tr.docChanged) return null
    return v
  },
})

// ── 빈칸 (‹…›) 이어 채우기 ──
const setSlots = StateEffect.define<{ from: number; to: number }[]>()
export const slots = StateField.define<{ from: number; to: number }[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setSlots)) return e.value
    return tr.docChanged ? v.map(r => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) })).filter(r => r.to >= r.from) : v
  },
})

function apply(view: EditorView, from: number, to: number, text: string) {
  const line = view.state.doc.lineAt(from)
  const indent = /^ */.exec(line.text)![0]
  text = text.replace(/\n/g, '\n' + indent)
  const rs: { from: number; to: number }[] = []
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '‹') {
      const j = text.indexOf('›', i)
      const inner = text.slice(i + 1, j)
      rs.push({ from: from + out.length, to: from + out.length + inner.length })
      out += inner; i = j; continue
    }
    out += text[i]
  }
  const spec: TransactionSpec = { changes: { from, to, insert: out }, effects: setSlots.of(rs.slice(1)) }
  spec.selection = rs.length ? { anchor: rs[0].from, head: rs[0].to } : { anchor: from + out.length }
  view.dispatch(spec)
}

export function nextSlot(view: EditorView): boolean {
  const s = view.state.field(slots)
  if (!s.length) return false
  const [first, ...rest] = s
  view.dispatch({ selection: { anchor: first.from, head: first.to }, effects: setSlots.of(rest), scrollIntoView: true })
  return true
}

// ── 후보 ──
function score(q: string, label: string, words = ''): number {
  if (!q) return 1
  const l = label.toLowerCase(), ql = q.toLowerCase()
  if (l === ql) return 0 // 이미 다 침
  if (l.startsWith(ql)) return 100 - l.length
  if (l.includes(ql)) return 60 - l.length
  let i = 0
  for (const c of l) if (c === ql[i]) i++
  if (i === ql.length) return 30 - l.length
  if (words.includes(q)) return 20
  return -1
}

/** 점 앞의 식: cart.find(.qty > 0)?.product → 괄호를 맞춰 거꾸로 읽는다 */
function exprBefore(text: string): string | undefined {
  let i = text.length, d = 0
  while (i > 0) {
    const c = text[i - 1]
    if (c === ')' || c === ']') d++
    else if (c === '(' || c === '[') { if (d === 0) break; d-- }
    else if (d === 0 && !/[\p{L}\p{N}_.?"]/u.test(c)) break
    i--
  }
  const out = text.slice(i).trim()
  return out || undefined
}

/** 부를 때 넣을 글: 받는 것들의 이름이 빈칸이 된다 → read(‹path›) */
function callText(name: string, ft: Extract<Ty, { k: 'fn' }>, each?: number): string {
  const need = ft.params.filter(p => !p.opt && resolve(p.ty).k !== 'opt')
  if (!need.length) return `${name}()`
  return `${name}(${need.map((p, i) => i === each ? '.‹›' : `‹${p.name ?? 'x'}›`).join(', ')})`
}

/** 이 타입의 값 뒤에 . 을 찍으면 나오는 것: 칸 → 값 → 할 수 있는 것 */
function membersFor(a: Analysis, t0: Ty, dotAt: number): Item[] {
  const out: Item[] = []
  let t = resolve(t0)
  let at: number | undefined, note = ''
  if (t.k === 'opt') { t = resolve(t.of); at = dotAt; note = ' · 없을 수도 있어서 ?. 로' }
  const pre = at !== undefined ? '?.' : ''
  if (t.k === 'model') {
    for (const f of a.fieldsOf(t.n)) {
      const ft = a.tyOf(f)
      out.push({ label: f.name, kind: (f.kind === 'computed' ? '계산 칸' : '칸') + note, detail: known(ft) ? show(ft) : f.type?.text, insert: pre + f.name, at, tone: 'field', rank: 0 })
    }
    return out
  }
  if (t.k === 'host') {
    for (const [k, v] of Object.entries(HOSTS[t.n]?.fields ?? {})) out.push({ label: k, kind: '칸' + note, detail: v, insert: pre + k, at, tone: 'field', rank: 0 })
    return out
  }
  if (t.k === 'list') {
    const el = resolve(t.of)
    if (el.k === 'model') for (const f of a.fieldsOf(el.n)) {
      const ft = a.tyOf(f)
      out.push({ label: f.name, kind: `각 ${el.n} 의 칸`, detail: known(ft) ? show(ft) + '[]' : undefined, insert: pre + f.name, at, tone: 'field', rank: 2 })
    }
  }
  const { list, s } = membersOf(t)
  for (const m of list) {
    const mt = memberTy(m, s)
    if (m.kind === 'prop') out.push({ label: m.name, kind: '값' + note, detail: show(mt), info: m.doc, insert: pre + m.name, at, tone: 'prop', rank: 1 })
    else {
      const ft = mt as Extract<Ty, { k: 'fn' }>
      out.push({ label: m.name + '()', kind: '할 수 있는 것' + note, detail: `${show(ft).replace(/^\((.*)\) -> /, '($1) → ')}`, info: m.doc + (m.each !== undefined ? '  ·  .칸 으로 각 항목을 가리켜' : ''), insert: pre + callText(m.name, ft, m.each), at, tone: 'method', rank: 3 })
    }
  }
  return out
}

function candidates(state: EditorState, pos: number): Deck | null {
  try { return candidates0(state, pos) } catch (e) { console.error('deck', e); return null }
}
function candidates0(state: EditorState, pos: number): Deck | null {
  const { a } = state.field(live)
  const line = state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const slash = /^(\s*)\/([\p{L}\p{N}_ ]*)$/u.exec(before)
  if (slash) {
    const q = slash[2].trim()
    const items = ACTIONS.map(x => ({ label: x.label, kind: '만들기', info: x.info, insert: x.text, score: score(q, x.label, x.words + ' ' + x.info), tone: 'make' }))
      .filter(x => x.score >= 0 && (q ? x.score > 0 : true)).sort((x, y) => y.score! - x.score!)
    return items.length ? { items, sel: 0, from: line.from + slash[1].length, to: pos, slash: true } : null
  }
  const m = /(?:(\.)|^|[^\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_]*)?$/u.exec(before)
  if (!m) return null
  const word = m[2] ?? ''
  const dot = !!m[1]
  if (!dot && !word) return null
  if (/^\s*(model|fn)\s+\S*$/.test(before) || /"[^"]*$/.test(before) || /\/\//.test(before)) return null
  const from = pos - word.length
  const items: Item[] = []
  const seen = new Set<string>()
  const add = (it: Item) => { if (seen.has(it.label)) return; const s = score(word, it.label, `${it.kind} ${it.info ?? ''}`); if (s > 0 || (!word && dot)) { seen.add(it.label); items.push({ ...it, score: s }) } }
  const no = line.number - 1
  if (dot) {
    const dotAt = from - 1
    const obj = exprBefore(before.slice(0, before.length - word.length - 1))
    const t = obj ? a.tyOfText(obj, no) : undefined
    if (t) for (const it of membersFor(a, t, dotAt)) add(it)
  } else {
    const bare = /(?:on[A-Z]\w*|bind)=$/.test(before.slice(0, before.length - word.length)) || /^\s*$/.test(before.slice(0, before.length - word.length))
    for (const s of a.scopeAt(no)) {
      const d = describe(a, state, s)
      const ft = resolve(a.tyOf(s))
      const insert = !bare && ft.k === 'fn' && (s.kind === 'fn') ? callText(s.name, ft) : s.name
      add({ label: s.name, kind: d.kind, detail: d.type, info: d.value ?? d.more, insert, tone: s.kind, rank: 0 })
    }
    for (const [k, v] of a.std) {
      const mod = stdModuleOf(k) ?? ''
      let ft: Ty | undefined
      try { ft = v.ty ? resolve(a.tyOfText(k, no)) : undefined } catch { ft = undefined }
      const insert = !bare && ft?.k === 'fn' && v.kind !== 'top' && v.kind !== 'tag' ? callText(k, ft) : k
      add({ label: k, kind: v.kind === 'tag' ? `${mod} 부품` : `${mod}${v.fails ? ' · 실패 가능' : ''}`, info: v.doc, detail: ft && known(ft) ? show(ft) : v.sig, insert, tone: 'std', rank: 1 })
    }
    for (const k of ['fn', 'for', 'if', 'else', 'match', 'catch', 'fail', 'model', 'use', 'check', 'and', 'or', 'not', 'none', 'true', 'false']) if (KEYWORDS.has(k)) add({ label: k, kind: '키워드', insert: k, tone: 'kw', rank: 2 })
    // 아직 고르지 않은 화면 부품: 넣으면 use 도 같이 넣는다
    if (word.length >= 2) for (const [mod, m] of Object.entries(STD)) for (const [k, v] of Object.entries(m)) if (!a.std.has(k)) add({ label: k, kind: `${mod} · use 자동`, info: `${v.doc} — ${MODULE_DOC[mod] ?? ''}`, insert: k, tone: 'far', rank: 3, use: mod })
  }
  items.sort((x, y) => word ? (y.score ?? 0) - (x.score ?? 0) || (x.rank ?? 0) - (y.rank ?? 0) : (x.rank ?? 0) - (y.rank ?? 0))
  if (!items.length || (items.length === 1 && items[0].label === word)) return null
  return { items: items.slice(0, 24), sel: 0, from, to: pos, slash: false }
}

function accept(view: EditorView): boolean {
  const d = view.state.field(deckField)
  if (!d) return false
  const it = d.items[d.sel]
  view.dispatch({ effects: setDeck.of(null) })
  apply(view, it.at ?? d.from, view.state.selection.main.head, it.insert)
  if (it.use) addUse(view, it.use)
  return true
}

/** use std.[mod.*] 을 알아서: 있으면 목록에 붙이고, 없으면 맨 위에 한 줄 */
export function addUse(view: EditorView, mod: string) {
  const doc = view.state.doc.toString()
  if (new RegExp(`use std\\.\\[[^\\]]*\\b${mod}\\.`).test(doc)) return
  const m = /^use std\.\[([^\]]*)\]/m.exec(doc)
  if (m) { const at = m.index + m[0].length - 1; view.dispatch({ changes: { from: at, insert: `${m[1].trim() ? ', ' : ''}${mod}.*` }, userEvent: 'input.use' }) }
  else view.dispatch({ changes: { from: 0, insert: `use std.[${mod}.*]\n\n` }, userEvent: 'input.use' })
}

const GLYPH: Record<string, string> = { field: '●', prop: '○', method: 'ƒ' }
function groupName(it: Item): string {
  if (it.tone === 'field') return it.kind.startsWith('각') ? '각 항목의 칸' : '칸'
  if (it.tone === 'prop') return '값'
  if (it.tone === 'method') return '할 수 있는 것'
  return ['여기 있는 것', '기본 제공', '키워드', '고르면 use 도 넣어줄게'][it.rank ?? 0] ?? ''
}
void GLYPH

// ── 그리기 ──
class DeckView {
  root: HTMLElement
  shown: Deck | null = null
  constructor(readonly view: EditorView) {
    this.root = document.createElement('div')
    this.root.className = 'deck'
    this.root.hidden = true
    document.body.append(this.root)
    this.root.addEventListener('mousedown', e => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('.deck-card')
      if (!c) return
      e.preventDefault()
      const i = Number(c.dataset.i)
      const d = view.state.field(deckField)
      if (!d) return
      if (i === d.sel) accept(view)
      else view.dispatch({ effects: move.of(i - d.sel) })
    })
    this.root.addEventListener('wheel', e => { e.preventDefault(); view.dispatch({ effects: move.of(e.deltaY > 0 ? 1 : -1) }) }, { passive: false })
  }
  update(u: ViewUpdate) {
    const d = u.state.field(deckField)
    const userTyped = u.transactions.some(t => t.isUserEvent('input.type') || t.isUserEvent('delete.backward'))
    if (userTyped && u.state.selection.main.empty) {
      const next = candidates(u.state, u.state.selection.main.head)
      const cur = d
      queueMicrotask(() => {
        const keep = cur && next && cur.from === next.from ? next.items.findIndex(x => x.label === cur.items[cur.sel]?.label) : -1
        u.view.dispatch({ effects: setDeck.of(next ? { ...next, sel: Math.max(0, keep) } : null) })
      })
    }
    if (d !== this.shown) { this.shown = d; this.view.requestMeasure({ read: v => d ? v.coordsAtPos(v.state.selection.main.head) : null, write: c => this.draw(c) }) }
  }
  draw(c: { left: number; top: number; bottom: number } | null) {
    const d = this.shown
    if (!d) { this.root.hidden = true; this.root.textContent = ''; this.root.dataset.sig = ''; return }
    this.root.hidden = false
    if (c) { this.root.style.left = `${c.left + 22}px`; this.root.style.top = `${(c.top + c.bottom) / 2}px` }
    // 재사용: 같은 목록이면 위치만 바꾼다 (카드가 돈다)
    const sig = d.items.map(x => x.label).join('|')
    if (this.root.dataset.sig !== sig) {
      this.root.dataset.sig = sig
      this.root.textContent = ''
      const stage = document.createElement('div'); stage.className = 'deck-stage'
      const flat = !d.slash
      this.root.classList.toggle('flat', flat)
      let lastG = ''
      d.items.forEach((it, i) => {
        if (flat) {
          const g = groupName(it)
          if (g !== lastG) { lastG = g; const h = document.createElement('div'); h.className = 'deck-g'; h.textContent = g; stage.append(h) }
        }
        const card = document.createElement('div')
        card.className = `deck-card t-${it.tone}`
        card.dataset.i = String(i)
        const top = document.createElement('div'); top.className = 'deck-top'
        const b = document.createElement('b'); b.textContent = it.label
        const k = document.createElement('i'); k.textContent = it.kind
        top.append(b, k)
        card.append(top)
        if (it.detail || it.info) {
          const more = document.createElement('div'); more.className = 'deck-more'
          if (it.detail) { const e = document.createElement('em'); e.textContent = it.detail; more.append(e) }
          if (it.info) { const s = document.createElement('span'); s.textContent = it.info; more.append(s) }
          card.append(more)
        }
        stage.append(card)
      })
      const hint = document.createElement('div'); hint.className = 'deck-hint'; hint.textContent = d.slash ? '↑↓ 돌리기 · ↵ 만들기 · esc' : '↑↓ 돌리기 · ↵/tab 넣기 · esc'
      this.root.append(stage, hint)
    }
    const cards = this.root.querySelectorAll<HTMLElement>('.deck-card')
    if (!d.slash) {
      // 평평한 목록: 전부 또렷하게, 고른 것만 밝게. 아래 자리가 모자라면 줄 위로 뒤집는다
      cards.forEach((card, i) => { card.classList.toggle('sel', i === d.sel); card.style.cssText = '' })
      if (c) {
        const h = this.root.getBoundingClientRect().height || 340
        const up = c.bottom + h + 40 > window.innerHeight && c.top - h - 20 > 0
        this.root.classList.toggle('up', up)
        this.root.style.top = up ? `${c.top - h - 8}px` : `${c.bottom + 4}px`
        this.root.style.left = `${c.left - 8}px`
      }
      cards[d.sel]?.scrollIntoView({ block: 'nearest' })
      return
    }
    cards.forEach((card, i) => {
      const o = i - d.sel
      const a = Math.abs(o)
      card.classList.toggle('sel', o === 0)
      // 드럼: 축에서 R 만큼 떨어진 카드들이 돈다
      const R = 190, step = 16
      card.style.transform = `translateY(-50%) translateZ(${-R}px) rotateX(${-o * step}deg) translateZ(${R}px) translateX(${a * 6}px)`
      card.style.opacity = a > 3 ? '0' : '1'
      card.style.filter = o === 0 ? '' : `brightness(${1 - a * 0.16}) saturate(${1 - a * 0.2})`
      card.style.zIndex = String(100 - a)
      card.style.pointerEvents = a > 3 ? 'none' : ''
    })
  }
  destroy() { this.root.remove() }
}

export const deck = [
  deckField,
  slots,
  ViewPlugin.fromClass(DeckView),
  Prec.highest(keymap.of([
    { key: 'ArrowDown', run: v => { if (!v.state.field(deckField)) return false; v.dispatch({ effects: move.of(1) }); return true } },
    { key: 'ArrowUp', run: v => { if (!v.state.field(deckField)) return false; v.dispatch({ effects: move.of(-1) }); return true } },
    { key: 'Enter', run: accept },
    { key: 'Tab', run: v => accept(v) || nextSlot(v) },
    { key: 'Escape', run: v => { if (v.state.field(deckField)) { v.dispatch({ effects: setDeck.of(null) }); return true } if (v.state.field(slots).length) { v.dispatch({ effects: setSlots.of([]) }); return true } return false } },
  ])),
]
