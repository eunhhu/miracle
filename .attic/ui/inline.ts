// 그 자리에서 보이는 것들: 블록 강조, 같은 이름, 커서 위 렌즈, 마우스 위 설명·미리보기,
// 줄 끝 남은 칸 안내, 블록 아래 실제 미리보기, system 실행 단추, 블록 사이 참조.

import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, Decoration, WidgetType, showTooltip, hoverTooltip, showPanel, ViewPlugin, type Tooltip, type ViewUpdate } from '@codemirror/view'
import { world, hereField, hoverLine, setHover, simOf, rootAt, lastLine, nodeAt, type World } from './state'
import { WORDS, placeOf, slotHint, emptyHint, ACTIONS, type Place } from './learn'
import { renderUnit } from './preview'
import { here, type Here, type Sym } from '../lang/inspect'
import { classify } from '../lang/tokenize'
import type { Analysis, Node } from '../lang/analyze'
import type { Sim } from '../lang/sim'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const KIND: Record<string, string> = {
  model: 'model', field: '칸', interface: 'interface', port: '포트', component: 'component', system: 'system',
  instance: '예시 데이터', event: '사건', var: '이름', fail: '실패', type: '타입', keyword: '키워드', value: '값', sample: 'sample', app: 'app',
}

export function jumpTo(view: EditorView, from: number, to = from) {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
  view.focus()
}
export function jumpLine(view: EditorView, no: number) {
  const l = view.state.doc.line(Math.min(no + 1, view.state.doc.lines))
  jumpTo(view, l.from + /^ */.exec(l.text)![0].length)
}

// ── 블록 강조 · 같은 이름 · 미리보기에서 가리킨 줄 ──────

const blockDeco = EditorView.decorations.compute([world, hereField, hoverLine, 'selection'], state => {
  const { a } = state.field(world)
  const h = state.field(hereField)
  const doc = state.doc
  const no = doc.lineAt(state.selection.main.head).number - 1
  const marks: { from: number; to: number; d: Decoration }[] = []
  const root = rootAt(a, no)
  const inner = nodeAt(a, no)
  if (root) {
    const end = lastLine(root)
    const ia = inner && inner !== root ? inner.line.no : -1
    const ib = inner && inner !== root ? lastLine(inner) : -2
    for (let i = root.line.no; i <= end && i < doc.lines; i++) {
      const cls = ['blk', i === root.line.no ? 'blk-head' : '', i === end ? 'blk-end' : '', i >= ia && i <= ib ? 'blk-inner' : ''].filter(Boolean).join(' ')
      marks.push({ from: doc.line(i + 1).from, to: doc.line(i + 1).from, d: Decoration.line({ class: cls }) })
    }
  }
  const hv = state.field(hoverLine)
  if (hv !== null && hv < doc.lines) marks.push({ from: doc.line(hv + 1).from, to: doc.line(hv + 1).from, d: Decoration.line({ class: 'pv-src' }) })
  for (const r of h.refs) {
    if (r.to > doc.length) continue
    const isDef = h.def && r.from === h.def.from
    marks.push({ from: r.from, to: r.to, d: Decoration.mark({ class: isDef ? 'ref ref-def' : 'ref' }) })
  }
  marks.sort((x, y) => x.from - y.from || (x.from === x.to ? -1 : 1))
  const b = new RangeSetBuilder<Decoration>()
  for (const m of marks) b.add(m.from, m.to, m.d)
  return b.finish()
})

// ── 커서 위 렌즈 ────────────────────────────────────────

const TYPES = ['Text', 'Number', 'Bool', 'Time', 'Path', 'Bytes']

/** 치는 중에는 렌즈를 숨긴다. 커서만 옮기면 다시 뜬다 */
const typing = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.docChanged ? true : tr.selection ? false : v,
})

class LensWidget extends WidgetType {
  constructor(readonly h: Here, readonly key: string) { super() }
  eq(o: LensWidget) { return o.key === this.key }
  toDOM(view: EditorView) { return lensDOM(view, this.h) }
  ignoreEvent() { return true }
}

/** 렌즈는 커서 줄 끝에 붙는다. 코드를 가리지 않는다 */
const lens = EditorView.decorations.compute([hereField, world, typing, 'selection'], state => {
  if (state.field(typing)) return Decoration.none
  const h = state.field(hereField)
  const t = h.token
  if (!t || !t.kind || !state.selection.main.empty) return Decoration.none
  if (t.kind === 'keyword' && !WORDS[t.text]) return Decoration.none
  const line = state.doc.lineAt(state.selection.main.head)
  const key = JSON.stringify([t.segFrom, t.text, t.id, h.value, h.values, h.writers, h.readers, h.refs.length])
  return Decoration.set([Decoration.widget({ widget: new LensWidget(h, key), side: 3 }).range(line.to)])
})

function lensDOM(view: EditorView, h: Here): HTMLElement {
  const t = h.token!
  const { a, syms } = view.state.field(world)
  const el = document.createElement('div')
  el.className = 'lens lens-inline'
  const parts: string[] = []
  const name = t.id?.replace(/^var:/, '') ?? t.text
  if (t.kind === 'keyword' || (t.kind === 'type' && WORDS[t.text] && !syms.has(t.text))) {
    const w = WORDS[t.text]
    parts.push(`<span class="lens-tag">${t.kind === 'type' ? '타입' : '키워드'}</span><b>${esc(t.text)}</b><span class="lens-what">${esc(w?.what ?? '')}</span>`)
  } else {
    parts.push(`<span class="lens-tag k-${t.kind}">${KIND[t.kind!] ?? t.kind}</span><b>${esc(name)}</b>`)
    if (t.type) parts.push(`<span class="lens-type">${esc(t.type)}</span>`)
    if (h.value && h.value !== '◌') parts.push(`<span class="lens-val">${esc(h.value)}</span>`)
    else if (h.values?.length) parts.push(`<span class="lens-val">${h.values.map(v => `<i>${esc(v.label)}</i> ${esc(v.value)}`).join('  ')}</span>`)
    else if (h.value === '◌') parts.push(`<span class="lens-hole">◌ 아직 없는 이름</span>`)
    if (h.writers.length) parts.push(`<span class="lens-rw w">씀 ${h.writers.map(s => `<button data-sys="${esc(s)}">${esc(s)}</button>`).join('')}</span>`)
    if (h.readers.length) parts.push(`<span class="lens-rw r">읽음 ${h.readers.map(s => `<button data-sys="${esc(s)}">${esc(s)}</button>`).join('')}</span>`)
  }
  // 이 자리에서 할 수 있는 것
  const acts: string[] = []
  if (t.kind === 'type' || (t.kind && syms.get(t.text)?.kind === 'model' && /^\s*[a-z]/.test(view.state.doc.lineAt(t.segFrom).text) && placeAt(view.state, t.segFrom) === 'model')) {
    const models = [...(a.w?.models.keys() ?? [])]
    const opts = [...TYPES, ...models].filter(x => x !== t.text)
    acts.push(`<span class="lens-swap">${opts.map(o => `<button data-type="${esc(o)}">${esc(o)}</button>`).join('')}</span>`)
  }
  if (/^-?\d/.test(t.text) && !t.id) acts.push(`<kbd>⇠ 드래그 ⇢</kbd><kbd>⌥↑↓</kbd>`)
  else if (h.def && h.def.from !== t.segFrom) acts.push(`<button class="lens-go" data-def>정의로 <kbd>F12</kbd></button>`)
  if (h.refs.length > 1) acts.push(`<span class="lens-dim">${h.refs.length}곳 <kbd>F8</kbd></span>`)
  el.innerHTML = `<span class="lens-row">${parts.join('')}</span>` + (acts.length ? `<span class="lens-row lens-acts">${acts.join('')}</span>` : '')
  el.querySelectorAll<HTMLButtonElement>('[data-sys]').forEach(b => b.onmousedown = e => {
    e.preventDefault()
    const sh = a.shapes.find(s => s.name === b.dataset.sys)
    if (sh) jumpLine(view, sh.line)
  })
  el.querySelectorAll<HTMLButtonElement>('[data-def]').forEach(b => b.onmousedown = e => { e.preventDefault(); jumpTo(view, h.def!.from, h.def!.to) })
  el.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(b => b.onmousedown = e => {
    e.preventDefault()
    view.dispatch({ changes: { from: t.segFrom, to: t.segTo, insert: b.dataset.type! }, selection: { anchor: t.segFrom + b.dataset.type!.length }, userEvent: 'input.type' })
  })
  return el
}

function placeAt(state: EditorState, pos: number): Place {
  const lines = state.doc.toString().split('\n')
  return placeOf(lines, state.doc.lineAt(pos).number - 1).place
}

// ── 마우스 위: 정의 미리보기 · 단어 설명 ────────────────

const hover = hoverTooltip((view, pos) => {
  const { a, syms } = view.state.field(world)
  const h = here(a, pos, syms)
  const t = h.token
  if (!t) return null
  const word = WORDS[t.text]
  const def = h.def
  const onDef = def && def.from <= pos && pos <= def.to
  if ((!def || onDef) && !word) return null
  return {
    pos: t.segFrom, end: t.segTo, above: false,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'peek'
      if (def && !onDef) dom.appendChild(peekBlock(view, a, def))
      else if (word) {
        dom.innerHTML = `<div class="peek-head"><b>${esc(t.text)}</b><span>${esc(word.what)}</span></div>` + (word.ex ? `<pre class="peek-ex">${colorize(word.ex)}</pre>` : '')
      }
      return { dom }
    },
  }
}, { hoverTime: 250 })

/** 정의가 들어 있는 블록을 작게 그대로 보여 준다. 줄을 누르면 그리로 */
function peekBlock(view: EditorView, a: Analysis, def: Sym) {
  const wrap = document.createElement('div')
  const root = rootAt(a, def.line)
  const doc = view.state.doc
  const from = root?.line.no ?? def.line
  const to = Math.min(root ? lastLine(root) : def.line, from + 11)
  wrap.innerHTML = `<div class="peek-head"><b>${esc(def.id)}</b><span>${KIND[def.kind]} · ${def.line + 1}줄</span><kbd>⌘클릭</kbd></div>`
  const pre = document.createElement('pre')
  pre.className = 'peek-code'
  for (let i = from; i <= to; i++) {
    const row = document.createElement('div')
    row.className = i === def.line ? 'on' : ''
    row.innerHTML = colorize(doc.line(i + 1).text) || ' '
    row.onmousedown = e => { e.preventDefault(); jumpLine(view, i) }
    pre.appendChild(row)
  }
  wrap.appendChild(pre)
  return wrap
}

function colorize(src: string) {
  const toks = classify(src)
  let out = '', at = 0
  for (const t of toks) {
    if (t.from < at) continue
    out += esc(src.slice(at, t.from)) + `<span class="m-${t.type}">${esc(src.slice(t.from, t.to))}</span>`
    at = t.to
  }
  return out + esc(src.slice(at))
}

// ── 줄 끝 남은 칸 · 빈 줄 안내 ──────────────────────────

class GhostWidget extends WidgetType {
  constructor(readonly text: string, readonly empty: boolean) { super() }
  eq(o: GhostWidget) { return o.text === this.text }
  toDOM() {
    const s = document.createElement('span')
    s.className = this.empty ? 'ghost ghost-empty' : 'ghost'
    s.textContent = this.text
    return s
  }
  ignoreEvent() { return false }
}

const ghost = EditorView.decorations.compute(['doc', 'selection'], state => {
  const sel = state.selection.main
  if (!sel.empty) return Decoration.none
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return Decoration.none
  const lines = state.doc.toString().split('\n')
  const { place } = placeOf(lines, line.number - 1)
  const text = !line.text.trim() ? emptyHint(place) : slotHint(line.text, place)
  if (!text) return Decoration.none
  const gap = !line.text.trim() || line.text.endsWith(' ') ? '' : '  '
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(gap + text, !line.text.trim()), side: 1 }).range(line.to)])
})

// ── 블록 아래 실제 미리보기 ─────────────────────────────

const toggleHidden = StateEffect.define<string>()
const hiddenField = StateField.define<Set<string>>({
  create: () => new Set(),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(toggleHidden)) { v = new Set(v); v.has(e.value) ? v.delete(e.value) : v.add(e.value) }
    return v
  },
})

class UnitWidget extends WidgetType {
  constructor(readonly line: number, readonly key: string, readonly sim: Sim) { super() }
  eq(o: UnitWidget) { return o.sim === this.sim && o.key === this.key && o.line === this.line }
  toDOM(view: EditorView) {
    const box = document.createElement('div')
    box.className = 'unit'
    const draw = () => {
      const a = view.state.field(world).a
      const root = a.roots.find(r => r.line.no === this.line)
      if (!root) return
      const focus = document.activeElement as HTMLInputElement | null
      const fkey = focus && box.contains(focus) ? focus.dataset.key : undefined
      const caret = fkey ? focus!.selectionStart : null
      const el = renderUnit(root, this.sim, {
        jump: no => jumpLine(view, no),
        hover: no => view.dispatch({ effects: setHover.of(no) }),
      })
      box.replaceChildren(...(el ? [el] : []))
      if (fkey) {
        const again = box.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(fkey)}"]`)
        if (again) { again.focus(); if (caret !== null) again.setSelectionRange(caret, caret) }
      }
      markOn(view, box)
    }
    draw()
    const off = this.sim.on(draw)
    offs.set(box, off)
    return box
  }
  destroy(dom: HTMLElement) { offs.get(dom)?.(); offs.delete(dom) }
  ignoreEvent() { return true }
}
const offs = new WeakMap<HTMLElement, () => void>()

/** 커서가 선 줄의 미리보기 요소에 표시 */
function markOn(view: EditorView, scope: ParentNode = view.dom) {
  const { a } = view.state.field(world)
  const no = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const n = nodeAt(a, no)
  const lo = n?.line.no ?? -1
  const hi = n ? lastLine(n) : -1
  scope.querySelectorAll<HTMLElement>('[data-line]').forEach(el => {
    const l = Number(el.dataset.line)
    el.classList.toggle('pv-on', l === lo || (l >= lo && l <= hi && el.parentElement?.closest('.pv-on') === null))
  })
}

const UNIT_HEADS = new Set(['interface', 'component', 'model'])

const units = EditorView.decorations.compute([world, hiddenField], state => {
  const hidden = state.field(hiddenField)
  const { a } = state.field(world)
  const sim = simOf(a)
  const doc = state.doc
  const b = new RangeSetBuilder<Decoration>()
  for (const r of a.roots) {
    if (!UNIT_HEADS.has(r.head)) continue
    const key = r.line.text.trim()
    if (hidden.has(key)) continue
    const end = lastLine(r)
    if (end + 1 > doc.lines) continue
    b.add(doc.line(end + 1).to, doc.line(end + 1).to, Decoration.widget({ widget: new UnitWidget(r.line.no, key, sim), block: true, side: 1 }))
  }
  return b.finish()
})

// ── 블록 머리 단추: ▶ 실행, 미리보기 접기, 참조 ─────────

class HeadWidget extends WidgetType {
  constructor(readonly line: number, readonly kind: string, readonly key: string, readonly sim: Sim, readonly refs: string, readonly hidden: boolean) { super() }
  eq(o: HeadWidget) { return o.sim === this.sim && o.key === this.key && o.refs === this.refs && o.hidden === this.hidden }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'head-chips'
    const a = view.state.field(world).a
    const root = a.roots.find(r => r.line.no === this.line)
    if (!root) return box
    if (this.kind === 'system') {
      const sys = this.sim.w.systems.find(s => s.node === root || s.node.line.no === root.line.no)
      if (sys) {
        const b = document.createElement('button')
        b.className = 'chip-run'
        const paint = () => {
          const last = [...this.sim.log].reverse().find(e => e.system === sys.name)
          b.innerHTML = `▶ <span>${esc(sys.trigger)}</span>` + (last ? (last.ok ? ' <i class="ok">✓</i>' : ` <i class="bad">✗ ${esc(last.fail ?? '')}</i>`) : '')
        }
        paint()
        const off = this.sim.on(paint)
        offs.set(box, off)
        b.title = '이 사건을 지금 세계에 일으킨다. 미리보기가 같이 바뀐다'
        b.onmousedown = e => {
          e.preventDefault()
          // component 안 사건이면 그 component 의 첫 항목을 . 으로
          const comp = a.roots.find(r => r.head === 'component' && sys.trigger.startsWith(r.line.main[1]?.text + '.'))
          const of = comp?.line.main.find((l, i, m) => m[i - 2]?.text === 'of' && m[i - 1]?.text === '=')?.text
          const subj = of ? this.sim.w.instancesOf(of)[0] : undefined
          this.sim.fire(sys.trigger, subj)
        }
        box.appendChild(b)
      }
    }
    if (UNIT_HEADS.has(this.kind)) {
      const b = document.createElement('button')
      b.className = 'chip-eye'
      b.textContent = this.hidden ? '미리보기 ▸' : '미리보기 ▾'
      b.onmousedown = e => { e.preventDefault(); view.dispatch({ effects: toggleHidden.of(this.key) }) }
      box.appendChild(b)
    }
    if (this.refs) {
      const g = JSON.parse(this.refs) as { out: [string, number][]; in: [string, number, string][] }
      if (g.out.length) {
        const s = document.createElement('span')
        s.className = 'chip-refs'
        s.innerHTML = '→ ' + g.out.map(([n, l]) => `<button data-l="${l}">${esc(n)}</button>`).join('')
        box.appendChild(s)
      }
      if (g.in.length) {
        const s = document.createElement('span')
        s.className = 'chip-refs in'
        s.innerHTML = '← ' + g.in.map(([n, l, k]) => `<button data-l="${l}" class="${k}">${esc(n)}</button>`).join('')
        box.appendChild(s)
      }
      box.querySelectorAll<HTMLButtonElement>('[data-l]').forEach(x => x.onmousedown = e => { e.preventDefault(); jumpLine(view, Number(x.dataset.l)) })
    }
    return box
  }
  destroy(dom: HTMLElement) { offs.get(dom)?.(); offs.delete(dom) }
  ignoreEvent() { return true }
}

const heads = EditorView.decorations.compute([world, hiddenField, 'selection'], state => {
  const hidden = state.field(hiddenField)
  const { a, syms } = state.field(world)
  const sim = simOf(a)
  const doc = state.doc
  const no = doc.lineAt(state.selection.main.head).number - 1
  const cur = rootAt(a, no)
  const g = graphOf(a, syms)
  const b = new RangeSetBuilder<Decoration>()
  for (const r of a.roots) {
    const useful = r.head === 'system' || UNIT_HEADS.has(r.head)
    const refs = r === cur ? JSON.stringify({
      out: [...(g.out.get(r) ?? [])].map(t => [label(t), t.line.no]),
      in: [...(g.in.get(r) ?? new Map()).entries()].map(([s, k]) => [label(s), s.line.no, k]),
    }) : ''
    if (!useful && !refs) continue
    const line = doc.line(r.line.no + 1)
    b.add(line.to, line.to, Decoration.widget({ widget: new HeadWidget(r.line.no, r.head, r.line.text.trim(), sim, refs, hidden.has(r.line.text.trim())), side: 2 }))
  }
  return b.finish()
})

const label = (n: Node) => (n.head === 'model' || n.head === 'system' || n.head === 'interface' || n.head === 'component' ? '' : n.head + ' ') + (n.line.main[1]?.text ?? '')

// ── 블록 사이 참조 그래프 ───────────────────────────────

interface Graph { out: Map<Node, Set<Node>>; in: Map<Node, Map<Node, 'w' | 'r'>> }
const graphs = new WeakMap<Analysis, Graph>()

export function graphOf(a: Analysis, syms: Map<string, Sym>): Graph {
  let g = graphs.get(a)
  if (g) return g
  g = { out: new Map(), in: new Map() }
  for (const r of a.roots) {
    const end = lastLine(r)
    for (let i = r.line.no; i <= end; i++) {
      const line = a.lines[i]
      if (!line) continue
      for (const lex of line.lex) {
        if (!/^(ident|path|subj)$/.test(lex.k)) continue
        for (let p = lex.from; p < lex.to; p++) {
          const h = here(a, p + 1, syms)
          const d = h.def
          if (d) {
            const t = rootAt(a, d.line)
            if (t && t !== r) {
              if (!g.out.has(r)) g.out.set(r, new Set())
              g.out.get(r)!.add(t)
              if (!g.in.has(t)) g.in.set(t, new Map())
              const writes = r.head === 'system' && h.writers.includes(r.line.main[1]?.text ?? '')
              const prev = g.in.get(t)!.get(r)
              g.in.get(t)!.set(r, prev === 'w' || writes ? 'w' : 'r')
            }
          }
          // 경로는 조각마다 볼 필요 있음: 점 다음으로 건너뛴다
          const dot = lex.text.indexOf('.', p - lex.from + 1)
          if (dot < 0) break
          p = lex.from + dot
        }
      }
    }
  }
  graphs.set(a, g)
  return g
}

// ── 맨 위 경로 띠 ───────────────────────────────────────

const crumbs = showPanel.of(view => {
  const dom = document.createElement('div')
  dom.className = 'crumbs-bar'
  const paint = (s: EditorState) => {
    const h = s.field(hereField)
    const lines = s.doc.toString().split('\n')
    const { place } = placeOf(lines, s.doc.lineAt(s.selection.main.head).number - 1)
    const acts = ACTIONS[place].slice(0, 6)
    dom.innerHTML =
      `<span class="crumbs">${h.crumbs.map(c => `<button data-l="${c.line}">${esc(c.label)}</button>`).join('<i>›</i>') || '<span class="dim">맨 바깥</span>'}</span>` +
      `<span class="can"><i>여기서</i>${acts.map(a => `<button data-act="${esc(a.word)}" title="${esc(a.what)}">${esc(a.label)}</button>`).join('')}<kbd>/</kbd></span>`
    dom.querySelectorAll<HTMLButtonElement>('[data-l]').forEach(b => b.onmousedown = e => { e.preventDefault(); jumpLine(view, Number(b.dataset.l)) })
    dom.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => b.onmousedown = e => { e.preventDefault(); openSlash(view, b.dataset.act!) })
  }
  paint(view.state)
  return { dom, top: true, update: u => { if (u.selectionSet || u.docChanged) paint(u.state) } }
})

/** 띠의 액션 단추 → / 메뉴를 그 단어로 연다 */
let openSlash: (view: EditorView, word: string) => void = () => {}
export function setOpenSlash(f: typeof openSlash) { openSlash = f }

// ── 미리보기 표시 갱신 ──────────────────────────────────

const markPlugin = ViewPlugin.fromClass(class {
  update(u: ViewUpdate) { if (u.selectionSet || u.docChanged) queueMicrotask(() => markOn(u.view)) }
})

const OFF = new Set((new URLSearchParams(location.search).get('off') ?? '').split(','))
const parts: [string, Extension][] = [['block', blockDeco], ['lens', lens], ['hover', hover], ['ghost', ghost], ['units', units], ['heads', heads], ['crumbs', crumbs], ['mark', markPlugin]]
export const inline: Extension = [world, hereField, hoverLine, hiddenField, typing, ...parts.filter(([n]) => !OFF.has(n)).map(([, e]) => e)]
export type { World }
