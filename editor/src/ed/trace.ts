// 따라가기: 커서가 가리키는 것(없으면 지금 블록)이 어디서 태어나고 어디서 쓰이는지
// 코드 위를 가로지르는 선으로 그린다. 평소엔 옅게, 이름 위에 마우스를 올리거나
// ⌥ 를 누르고 있거나 막 도착했을 때 또렷하게. 줄 번호 옆 눈금은 눌러서 이동.
import { EditorView, GutterMarker, ViewPlugin, gutter, gutterLineClass, layer, type LayerMarker, type ViewUpdate } from '@codemirror/view'
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { live } from './live'
import { symAt } from './lens'
import { focusBlock } from './block'
import type { Sym } from '../core/analyze'

export interface Site { line: number; pos: number; kind: 'def' | 'w' | 'r' }
export interface Trace { sym: Sym; sites: Site[]; label: string }

const RENAMABLE = new Set(['decl', 'local', 'param', 'fn', 'comp', 'model', 'field', 'computed', 'loop', 'binder', 'type'])

export function sameSym(a: Sym, b: Sym) { return a === b || (a.name === b.name && a.kind === b.kind && a.line === b.line && a.file === b.file) }

/** 이 이름이 나오는 모든 곳 (정의 + 쓰는 곳) */
export function occurrences(state: EditorState, sym: Sym): { from: number; to: number; kind: Site['kind'] }[] {
  const { a } = state.field(live)
  const out: { from: number; to: number; kind: Site['kind'] }[] = []
  if (sym.from >= 0 && !sym.file) out.push({ from: sym.from, to: sym.to, kind: 'def' })
  for (const r of a.refs) if (sameSym(r.sym, sym) && !out.some(o => o.from === r.from)) out.push({ from: r.from, to: r.to, kind: r.write ? 'w' : 'r' })
  return out.sort((x, y) => x.from - y.from)
}

export function traceOf(state: EditorState): Trace | undefined {
  const { a } = state.field(live)
  let sym = symAt(state, state.selection.main.head)?.sym
  if (sym && (sym.kind === 'std' || sym.kind === 'builtin')) sym = undefined
  if (!sym) {
    const b = state.field(focusBlock)
    if (b) sym = a.syms.find(s => s.line === b.from && s.name === b.name && s.from >= 0 && !s.file)
  }
  if (!sym) return
  const sites = occurrences(state, sym).map(o => ({ line: state.doc.lineAt(o.from).number, pos: o.from, kind: o.kind }))
  if (sites.length < 2 && !sym.file) return
  return { sym, sites, label: sym.name }
}

export const traceField = StateField.define<Trace | undefined>({
  create: s => traceOf(s),
  update(v, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.field(live) === tr.state.field(live)) return v
    const t = traceOf(tr.state)
    if (v && t && sameSym(v.sym, t.sym) && v.sites.length === t.sites.length && v.sites.every((s, i) => s.pos === t.sites[i].pos && s.kind === t.sites[i].kind)) return v
    return t
  },
})

export const renamable = (s: Sym) => RENAMABLE.has(s.kind)

// ── 줄 번호 강조 ──
class LineMark extends GutterMarker { constructor(readonly elementClass: string) { super() } }
const M = { def: new LineMark('tr-def'), w: new LineMark('tr-w'), r: new LineMark('tr-r') }
const lineClass = gutterLineClass.compute([traceField], s => {
  const t = s.field(traceField)
  if (!t) return RangeSet.empty
  const b = new RangeSetBuilder<GutterMarker>()
  const seen = new Map<number, Site['kind']>()
  for (const x of t.sites) { const k = seen.get(x.line); if (!k || x.kind === 'def' || (x.kind === 'w' && k === 'r')) seen.set(x.line, x.kind) }
  for (const [line, kind] of [...seen].sort((p, q) => p[0] - q[0])) { const l = s.doc.line(line); b.add(l.from, l.from, M[kind]) }
  return b.finish()
})

// ── 줄 번호 옆 눈금 (눌러서 이동) ──
class Tick extends GutterMarker {
  constructor(readonly k: string) { super() }
  eq(o: Tick) { return o.k === this.k }
  toDOM() { const d = document.createElement('span'); d.className = `tick ${this.k}`; return d }
}
const TICK = { def: new Tick('def'), w: new Tick('w'), r: new Tick('r') }
class Spacer extends GutterMarker { toDOM() { const d = document.createElement('span'); d.className = 'tick-sp'; return d } }
const ticks = gutter({
  class: 'cm-trace-gutter',
  initialSpacer: () => new Spacer(),
  markers: v => {
    const t = v.state.field(traceField)
    if (!t) return RangeSet.empty
    const b = new RangeSetBuilder<GutterMarker>()
    const seen = new Map<number, Site['kind']>()
    for (const x of t.sites) { const k = seen.get(x.line); if (!k || x.kind === 'def' || (x.kind === 'w' && k === 'r')) seen.set(x.line, x.kind) }
    for (const [line, kind] of [...seen].sort((p, q) => p[0] - q[0])) { const l = v.state.doc.line(line); b.add(l.from, l.from, TICK[kind]) }
    return b.finish()
  },
  domEventHandlers: {
    mousedown(view, block) {
      const t = view.state.field(traceField)
      const line = view.state.doc.lineAt(block.from).number
      const site = t?.sites.find(s => s.line === line)
      if (!site) return false
      view.dispatch({ selection: { anchor: site.pos }, effects: EditorView.scrollIntoView(site.pos, { y: 'center' }) })
      view.focus()
      return true
    },
  },
})

// ── 또렷하게: ⌥ 누름 · 이름 위 마우스 · 막 도착 ──
export const setHot = StateEffect.define<{ hot: boolean; pos?: number | null }>()
const hotField = StateField.define<{ hot: boolean; pos: number | null }>({
  create: () => ({ hot: false, pos: null }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHot)) return { hot: e.value.hot, pos: e.value.pos === undefined ? v.pos : e.value.pos }
    return v
  },
})

// ── 코드 위를 가로지르는 선 ──
class Flow implements LayerMarker {
  constructor(readonly svg: string, readonly key: string, readonly w: number, readonly h: number) {}
  eq(o: Flow) { return o.key === this.key }
  draw() { const d = document.createElement('div'); this.update(d); return d }
  update(d: HTMLElement) {
    d.className = 'flowbox'
    d.innerHTML = this.svg
    Object.assign(d.style, { left: '0px', top: '0px', width: `${this.w}px`, height: `${this.h}px` })
    return true
  }
}

const TONE: Record<string, string> = { model: 'm', type: 'm', field: 'm', computed: 'm', comp: 'c', fn: 'f' }

const flowLayer = layer({
  above: true,
  class: 'flow',
  update: u => u.geometryChanged || u.viewportChanged || u.docChanged || u.startState.field(traceField) !== u.state.field(traceField) || u.startState.field(hotField) !== u.state.field(hotField),
  markers(view) {
    const t = view.state.field(traceField)
    if (!t) return []
    const sr = view.scrollDOM.getBoundingClientRect()
    const ox = sr.left - view.scrollDOM.scrollLeft, oy = sr.top - view.scrollDOM.scrollTop
    const top = view.scrollDOM.scrollTop, bot = top + view.scrollDOM.clientHeight
    const W = view.contentDOM.offsetWidth + view.contentDOM.offsetLeft, H = view.contentDOM.offsetHeight + view.contentDOM.offsetTop
    const cleft = view.contentDOM.getBoundingClientRect().left - ox + 6
    const hot = view.state.field(hotField)
    const box = (pos: number) => {
      if (pos < view.viewport.from || pos > view.viewport.to) return null
      const a = view.coordsAtPos(pos, 1), b = view.coordsAtPos(Math.min(pos + 1, view.state.doc.length), -1)
      if (!a) return null
      if (a.bottom - oy < top || a.top - oy > bot) return null     // 그려졌지만 화면 밖
      return { l: a.left - ox, r: (b?.right ?? a.right) - ox, t: a.top - oy, b: a.bottom - oy, m: (a.top + a.bottom) / 2 - oy }
    }
    const def = t.sites.find(s => s.kind === 'def')
    const others = t.sites.filter(s => s !== def)
    const D = def ? box(def.pos) : null
    // 정의가 화면 밖이면 화면 가장자리 왼쪽에서 출발
    const defLine = def?.line ?? 0
    const curLine = view.state.doc.lineAt(view.state.selection.main.head).number
    const anchor = D ? { x: D.l + 3, y: D.b - 1, yTop: D.t + 1 } : { x: cleft, y: defLine && defLine < curLine ? top + 4 : bot - 4, yTop: defLine && defLine < curLine ? top + 4 : bot - 4 }
    const tone = TONE[t.sym.kind] ?? 's'
    let svg = `<svg class="${tone}${hot.hot ? ' hot' : ''}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    let above = 0, below = 0
    const parts: string[] = []
    // 길: 정의 → 왼쪽 여백의 세로 길 → 쓰이는 줄의 줄 사이 틈으로 들어가 → 그 글자 위에 내려앉기.
    // 글자를 가로지르지 않도록 세로는 여백, 가로는 줄 사이로만 다닌다.
    const tg = view.dom.querySelector('.cm-trace-gutter')?.getBoundingClientRect()
    const lane = tg ? tg.left + tg.width / 2 - ox : Math.max(4, cleft - 8)
    const r = 5
    for (const s of others) {
      const S = box(s.pos)
      if (!S) { if (s.line < curLine) above++; else below++; continue }
      const down = S.t >= (D?.b ?? anchor.y) - 2
      const x1 = anchor.x, y1 = down ? anchor.y + 1 : anchor.yTop - 1
      const tx = S.l + Math.min(6, (S.r - S.l) / 2)     // 내려앉을 자리
      const dir = down ? 1 : -1
      const f = (n: number) => n.toFixed(1)
      const same = !!D && Math.abs(S.t - D.t) < 4
      const half = Math.max(1.5, (view.defaultLineHeight - (S.b - S.t)) / 2)
      const gy2 = down ? S.t - half : S.b + half
      const gy1 = D ? (down ? D.b + half : D.t - half) : y1
      const k = Math.min(r, Math.abs(gy2 - gy1) / 2)
      const d = same
        ? `M${f(x1)} ${f(y1)} L${f(x1)} ${f(gy1)} L${f(tx)} ${f(gy1)} L${f(tx)} ${f(S.t + 1)}`
        : `M${f(x1)} ${f(y1)} L${f(x1)} ${f(gy1)} L${f(lane + k)} ${f(gy1)} Q${f(lane)} ${f(gy1)} ${f(lane)} ${f(gy1 + dir * k)}` +
          ` L${f(lane)} ${f(gy2 - dir * k)} Q${f(lane)} ${f(gy2)} ${f(lane + k)} ${f(gy2)} L${f(tx - 2)} ${f(gy2)} Q${f(tx)} ${f(gy2)} ${f(tx)} ${f(gy2 + dir * 2)}`
      const on = hot.pos === s.pos ? ' on' : ''
      parts.push(`<path class="e ${s.kind}${on}" data-p="${s.pos}" d="${d}"/>`)
      parts.push(`<line class="u ${s.kind}${on}" x1="${f(S.l)}" x2="${f(S.r)}" y1="${f(S.b - 0.5)}" y2="${f(S.b - 0.5)}"/>`)
    }
    if (D) parts.push(`<circle class="n def" cx="${anchor.x.toFixed(1)}" cy="${anchor.y.toFixed(1)}" r="3.4"/>`)
    else if (def) parts.push(`<g class="edge-note"><text x="${(cleft + 8).toFixed(1)}" y="${(anchor.y + (defLine < curLine ? 10 : -4)).toFixed(1)}">${defLine < curLine ? '↑' : '↓'} 정의 ${defLine}줄</text></g>`)
    if (above) parts.push(`<text class="edge-count" x="${(W - 14).toFixed(1)}" y="${(top + 14).toFixed(1)}" text-anchor="end">↑ ${above}곳 더</text>`)
    if (below) parts.push(`<text class="edge-count" x="${(W - 14).toFixed(1)}" y="${(bot - 8).toFixed(1)}" text-anchor="end">↓ ${below}곳 더</text>`)
    svg += parts.join('') + '</svg>'
    return [new Flow(svg, svg, W, H)]
  },
})

// ── 마우스와 ⌥ 로 또렷하게 ──
const flowHot = ViewPlugin.fromClass(class {
  flash = 0
  alt = false
  constructor(readonly view: EditorView) {
    this.key = this.key.bind(this)
    window.addEventListener('keydown', this.key, true)
    window.addEventListener('keyup', this.key, true)
    window.addEventListener('blur', this.key)
  }
  key(e: Event) {
    const k = e as KeyboardEvent
    const alt = e.type === 'keydown' ? k.key === 'Alt' || (this.alt && k.altKey) : e.type === 'keyup' ? (k.key === 'Alt' ? false : this.alt) : false
    if (alt === this.alt) return
    this.alt = alt
    this.set(alt)
  }
  set(hot: boolean, pos?: number | null) {
    const cur = this.view.state.field(hotField)
    if (cur.hot === hot && (pos === undefined || cur.pos === pos)) return
    queueMicrotask(() => this.view.dispatch({ effects: setHot.of({ hot, pos }) }))
  }
  update(u: ViewUpdate) {
    const a = u.startState.field(traceField), b = u.state.field(traceField)
    if (b && (!a || !sameSym(a.sym, b.sym))) {
      // 새 이름에 막 도착: 잠깐 또렷하게
      clearTimeout(this.flash)
      this.set(true)
      this.flash = window.setTimeout(() => { if (!this.alt) this.set(false, null) }, 1100)
    }
  }
  destroy() {
    window.removeEventListener('keydown', this.key, true)
    window.removeEventListener('keyup', this.key, true)
    window.removeEventListener('blur', this.key)
  }
}, {
  eventHandlers: {
    mousemove(e) {
      const t = this.view.state.field(traceField)
      if (!t) return
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false)
      const hit = pos !== null ? symAt(this.view.state, pos) : undefined
      const on = !!hit && sameSym(hit.sym, t.sym)
      const site = on ? t.sites.find(s => s.pos === hit!.from) : undefined
      if (on) { clearTimeout(this.flash); this.set(true, site?.pos ?? null) }
      else if (!this.alt && this.view.state.field(hotField).hot) this.set(false, null)
    },
    mouseleave() { if (!this.alt) this.set(false, null) },
  },
})

export const traceLines = [traceField, lineClass, hotField]
export const trace = [flowLayer, flowHot]
export const traceColumn = ticks
