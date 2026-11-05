// 겹: 블록 안의 블록. 지금 어느 겹에 있는지(줄기), 접기, 겹 단위로 움직이기.
import { EditorView, Decoration, ViewPlugin, layer, showPanel, type LayerMarker, type DecorationSet, type ViewUpdate, type Panel } from '@codemirror/view'
import { EditorSelection, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { codeFolding, foldGutter, foldService, foldedRanges, foldEffect, unfoldEffect, foldAll, unfoldAll, foldable } from '@codemirror/language'
import { live } from './live'
import { lastLineOf, type Node } from '../core/parse'
import type { Analysis } from '../core/analyze'

// ── 나무에서 줄 찾기 ──
export function nodeAt(a: Analysis, line0: number): Node | undefined {
  const n = a.tree.byLine[line0]
  if (n) return n
  // 빈 줄: 아래 첫 줄과 위 첫 줄 중 더 깊은 쪽의 부모
  let up: Node | undefined, down: Node | undefined
  for (let l = line0 - 1; l >= 0 && !up; l--) up = a.tree.byLine[l]
  for (let l = line0 + 1; l < a.tree.lines.length && !down; l++) down = a.tree.byLine[l]
  if (!up) return undefined
  if (!down) return up.parent ?? up
  // 아래 줄이 위 줄의 자식이거나 같은 겹이면, 그 부모 안에 있다
  let p: Node | undefined = up
  while (p && p.indent >= down.indent) p = p.parent
  return p ?? up
}

/** 뿌리 → 이 줄 */
export function chainOf(n: Node | undefined): Node[] {
  const out: Node[] = []
  for (let x = n; x; x = x.parent) out.unshift(x)
  return out
}

const hasBody = (n: Node) => n.children.length > 0

/** 이 노드가 차지하는 마지막 줄 (catch · else 까지) */
export function spanEnd(n: Node): number {
  let last = lastLineOf(n)
  if (n.catchNode) last = Math.max(last, lastLineOf(n.catchNode))
  let e = n.elseNode
  while (e) { last = Math.max(last, lastLineOf(e)); e = e.elseNode }
  return last
}

export function label(n: Node): string {
  const t = n.line.text.trim().replace(/\s*(\?|!|\/\/).*$/, '')
  return t.length > 34 ? t.slice(0, 33) + '…' : t
}

// ── 커서의 겹 ──
export interface Nest { chain: Node[]; inner?: Node }
export const nestField = StateField.define<Nest>({
  create: s => nestOf(s),
  update(v, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.field(live) === tr.state.field(live)) return v
    const n = nestOf(tr.state)
    return n.chain.length === v.chain.length && n.chain.every((x, i) => x === v.chain[i]) ? v : n
  },
})
function nestOf(s: EditorState): Nest {
  const { a } = s.field(live)
  const chain = chainOf(nodeAt(a, s.doc.lineAt(s.selection.main.head).number - 1))
  const inner = [...chain].reverse().find(hasBody)
  return { chain, inner }
}

// ── 줄기: 열린 겹마다 세로 줄, 가장 안쪽은 밝게 ──
class Rail implements LayerMarker {
  constructor(readonly x: number, readonly top: number, readonly h: number, readonly cls: string, readonly w = 0) {}
  eq(o: Rail) { return o.x === this.x && o.top === this.top && o.h === this.h && o.cls === this.cls && o.w === this.w }
  draw() { const d = document.createElement('div'); this.update(d); return d }
  update(d: HTMLElement) {
    d.className = this.cls
    Object.assign(d.style, { left: `${this.x}px`, top: `${this.top}px`, height: `${this.h}px`, width: this.w ? `${this.w}px` : '' })
    return true
  }
}

export const rails = layer({
  above: false,
  class: 'rails',
  update: u => u.docChanged || u.geometryChanged || u.viewportChanged || u.startState.field(nestField) !== u.state.field(nestField),
  markers(view) {
    const s = view.state
    const { a } = s.field(live)
    const { chain, inner } = s.field(nestField)
    const out: Rail[] = []
    const top = chain[0]
    if (!top) return out
    const sr = view.scrollDOM.getBoundingClientRect()
    const dy = view.documentTop - sr.top + view.scrollDOM.scrollTop
    const left0 = view.contentDOM.getBoundingClientRect().left - sr.left + view.scrollDOM.scrollLeft
    const cw = view.defaultCharacterWidth
    const pad = parseFloat(getComputedStyle(view.contentDOM.querySelector('.cm-line') ?? view.contentDOM).paddingLeft) || 0
    const doc = s.doc
    const inChain = new Set(chain)
    const folded = foldedRanges(s)
    const isHidden = (pos: number) => { let h = false; folded.between(pos, pos, (f, t) => { if (pos > f && pos <= t) h = true }); return h }
    const geo = (n: Node) => {
      const first = doc.line(n.no + 1), last = doc.line(Math.min(lastLineOf(n) + 1, doc.lines))
      if (isHidden(first.from)) return null
      const b1 = view.lineBlockAt(first.from), b2 = view.lineBlockAt(last.from)
      return { x: left0 + pad + n.indent * cw + cw * 0.5, y1: b1.bottom + dy - 2, y2: b2.bottom + dy - 4, top: b1.top + dy, bottom: b2.bottom + dy }
    }
    // 이 최상위 블록 안의 모든 겹 (희미하게)
    const visit = (n: Node, depth: number) => {
      if (hasBody(n)) {
        const g = geo(n)
        if (g && g.y2 > g.y1) {
          const cls = n === inner ? 'rail on' : inChain.has(n) ? 'rail path' : 'rail'
          out.push(new Rail(g.x, g.y1, g.y2 - g.y1, `${cls} d${Math.min(depth, 5)}`))
        }
      }
      for (const c of n.children) visit(c, depth + 1)
      if (n.catchNode) visit(n.catchNode, depth)
      let e = n.elseNode
      while (e) { visit(e, depth); e = e.elseNode }
    }
    visit(top, 0)
    // 가장 안쪽 겹: 띠
    if (inner && inner !== top) {
      const g = geo(inner)
      if (g) {
        const right = Math.min(view.contentDOM.getBoundingClientRect().width + left0, left0 + 960)
        out.unshift(new Rail(g.x - cw * 0.9, g.top - 1, g.bottom - g.top + 2, 'band', right - (g.x - cw * 0.9)))
      }
    }
    return out
  },
})

// ── 초점: 지금 블록 밖은 물러난다 ──
export const toggleDim = StateEffect.define<boolean>()
export const dimOn = StateField.define<boolean>({
  create: () => localStorage.getItem('miracle3:dim') !== '0',
  update(v, tr) { for (const e of tr.effects) if (e.is(toggleDim)) { localStorage.setItem('miracle3:dim', e.value ? '1' : '0'); return e.value } return v },
})
const dimLine = Decoration.line({ class: 'cm-far' })
const dim = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.startState.field(nestField) !== u.state.field(nestField) || u.startState.field(dimOn) !== u.state.field(dimOn)) this.decorations = this.build(u.view)
  }
  build(view: EditorView) {
    const s = view.state
    if (!s.field(dimOn)) return Decoration.none
    const top = s.field(nestField).chain[0]
    if (!top) return Decoration.none
    const from = top.no, to = spanEnd(top)
    const b = new RangeSetBuilder<Decoration>()
    for (const { from: vf, to: vt } of view.visibleRanges) {
      for (let pos = vf; pos <= vt;) {
        const l = s.doc.lineAt(pos)
        if (l.number - 1 < from || l.number - 1 > to) b.add(l.from, l.from, dimLine)
        pos = l.to + 1
      }
    }
    return b.finish()
  }
}, { decorations: v => v.decorations })

// ── 위 줄기 표시: 지금 어디 안에 있는지 ──
function crumbs(view: EditorView): Panel {
  const dom = document.createElement('nav')
  dom.className = 'crumbs'
  let sig = ''
  const draw = () => {
    const { chain } = view.state.field(nestField)
    const s = chain.map(n => n.no + ':' + n.line.text).join('|')
    if (s === sig) return
    sig = s
    dom.textContent = ''
    if (!chain.length) { const e = document.createElement('span'); e.className = 'crumb-empty'; e.textContent = '맨 바깥'; dom.append(e); return }
    chain.forEach((n, i) => {
      if (i) { const sep = document.createElement('i'); sep.textContent = '›'; dom.append(sep) }
      const b = document.createElement('button')
      b.className = `crumb${i === chain.length - 1 ? ' here' : ''}`
      b.textContent = label(n)
      b.title = `${n.no + 1}줄 · 누르면 이 겹 고르기`
      b.onmousedown = e => {
        e.preventDefault()
        const doc = view.state.doc
        const l1 = doc.line(n.no + 1), l2 = doc.line(Math.min(spanEnd(n) + 1, doc.lines))
        view.dispatch({ selection: EditorSelection.range(l1.from + n.indent, l2.to), scrollIntoView: true })
        view.focus()
      }
      dom.append(b)
    })
  }
  draw()
  return { dom, top: true, update: () => draw() }
}

// ── 접기 ──
const fold = foldService.of((state, from) => {
  const { a } = state.field(live)
  const line = state.doc.lineAt(from)
  const n = a.tree.byLine[line.number - 1]
  if (!n || !hasBody(n)) return null
  const end = state.doc.line(Math.min(lastLineOf(n) + 1, state.doc.lines))
  return end.number > line.number ? { from: line.to, to: end.to } : null
})

function summary(state: EditorState, range: { from: number; to: number }): string {
  const { a } = state.field(live)
  const l1 = state.doc.lineAt(range.from), l2 = state.doc.lineAt(range.to)
  const n = a.tree.byLine[l1.number - 1]
  const lines = l2.number - l1.number
  if (!n) return `${lines}줄`
  if (n.kind === 'model') return n.children.filter(c => c.kind === 'field' || c.kind === 'computed').map(c => c.name).join(' · ') || `${lines}줄`
  if (n.kind === 'fn') {
    const ch: string[] = []
    for (const [x, ls] of a.writes) if (ls.some(l => l > n.no && l <= l2.number - 1) && !ch.includes(x.name)) ch.push(x.name)
    const parts = n.children.map(c => c.name ?? label(c).split(' ')[0])
    return /^[A-Z]/.test(n.name ?? '') ? `${parts.slice(0, 4).join(' · ')}${parts.length > 4 ? ' …' : ''}` : ch.length ? `바꿈: ${ch.join(', ')}` : `${lines}줄`
  }
  const parts = n.children.map(c => label(c).split(/\s+/)[0])
  return `${parts.slice(0, 4).join(' · ')}${parts.length > 4 ? ' …' : ''}`
}

const folding = [
  fold,
  codeFolding({
    preparePlaceholder: (state, range) => summary(state, range),
    placeholderDOM(_view, onclick, prepared: string) {
      const e = document.createElement('span')
      e.className = 'fold-pill'
      e.textContent = prepared
      e.title = '펼치기'
      e.onclick = onclick
      return e
    },
  }),
  foldGutter({
    markerDOM(open) {
      const e = document.createElement('span')
      e.className = `fold-mark${open ? '' : ' shut'}`
      e.textContent = open ? '' : ''
      return e
    },
  }),
]

// ── 겹 단위 손 ──
function siblingsOf(a: Analysis, n: Node): Node[] { return n.parent ? n.parent.children : a.tree.roots }

/** 블록째 옮기기 (자식까지). 블록이 아니면 줄 옮기기에 맡긴다 */
function moveBlock(dir: -1 | 1) {
  return (view: EditorView): boolean => {
    const s = view.state
    if (!s.selection.main.empty) return false
    const { a } = s.field(live)
    const n = a.tree.byLine[s.doc.lineAt(s.selection.main.head).number - 1]
    if (!n || !hasBody(n)) return false
    const sib = siblingsOf(a, n)
    const i = sib.indexOf(n)
    const o = sib[i + dir]
    if (!o) return true
    const [A, B] = dir < 0 ? [o, n] : [n, o]
    const doc = s.doc
    const aFrom = doc.line(A.no + 1).from, aTo = doc.line(spanEnd(A) + 1).to
    const bFrom = doc.line(B.no + 1).from, bTo = doc.line(spanEnd(B) + 1).to
    const ta = doc.sliceString(aFrom, aTo), gap = doc.sliceString(aTo, bFrom), tb = doc.sliceString(bFrom, bTo)
    const off = s.selection.main.head - doc.line(n.no + 1).from
    const insert = tb + gap + ta
    const nStart = dir < 0 ? aFrom : aFrom + tb.length + gap.length
    view.dispatch({ changes: { from: aFrom, to: bTo, insert }, selection: { anchor: nStart + off }, scrollIntoView: true, userEvent: 'move.block' })
    return true
  }
}

/** 겹 넓히기 · 좁히기 */
const grow = StateEffect.define<{ from: number; to: number }[]>()
const growStack = StateField.define<{ from: number; to: number }[]>({
  create: () => [],
  update(v, tr) { for (const e of tr.effects) if (e.is(grow)) return e.value; return tr.docChanged || (tr.selection && !tr.effects.length) ? [] : v },
})
function expand(view: EditorView): boolean {
  const s = view.state
  const r = s.selection.main
  const { a } = s.field(live)
  const doc = s.doc
  let n = nodeAt(a, doc.lineAt(r.head).number - 1)
  const rangeOf = (x: Node) => ({ from: doc.line(x.no + 1).from + x.indent, to: doc.line(Math.min(spanEnd(x) + 1, doc.lines)).to })
  while (n) {
    const g = rangeOf(n)
    if (g.from <= r.from && g.to >= r.to && !(g.from === r.from && g.to === r.to)) {
      view.dispatch({ selection: EditorSelection.range(g.from, g.to), effects: grow.of([...s.field(growStack), { from: r.from, to: r.to }]) })
      return true
    }
    n = n.parent
  }
  view.dispatch({ selection: EditorSelection.range(0, doc.length), effects: grow.of([...s.field(growStack), { from: r.from, to: r.to }]) })
  return true
}
function shrink(view: EditorView): boolean {
  const st = view.state.field(growStack)
  if (!st.length) return false
  const last = st[st.length - 1]
  view.dispatch({ selection: EditorSelection.range(last.from, last.to), effects: grow.of(st.slice(0, -1)) })
  return true
}

/** 같은 겹의 앞 · 뒤 블록으로 */
function sibling(dir: -1 | 1) {
  return (view: EditorView): boolean => {
    const s = view.state
    const { a } = s.field(live)
    const n = nodeAt(a, s.doc.lineAt(s.selection.main.head).number - 1)
    if (!n) return false
    const sib = siblingsOf(a, n)
    const o = sib[sib.indexOf(n) + dir]
    if (!o) return true
    const l = s.doc.line(o.no + 1)
    view.dispatch({ selection: { anchor: l.from + o.indent }, scrollIntoView: true })
    return true
  }
}

function foldHere(view: EditorView): boolean {
  const s = view.state
  const { inner } = s.field(nestField)
  if (!inner) return false
  const l = s.doc.line(inner.no + 1)
  const r = foldable(s, l.from, l.to)
  if (!r) return false
  view.dispatch({ effects: foldEffect.of(r), selection: { anchor: l.from + inner.indent } })
  return true
}
function unfoldHere(view: EditorView): boolean {
  const s = view.state
  const line = s.doc.lineAt(s.selection.main.head)
  const eff: StateEffect<unknown>[] = []
  foldedRanges(s).between(line.from, line.to + 1, (from, to) => { eff.push(unfoldEffect.of({ from, to })) })
  if (!eff.length) return false
  view.dispatch({ effects: eff })
  return true
}

export const nestCommands = {
  moveBlockUp: moveBlock(-1), moveBlockDown: moveBlock(1),
  expand, shrink, prevSibling: sibling(-1), nextSibling: sibling(1),
  foldHere, unfoldHere, foldAll, unfoldAll,
  toggleDim: (v: EditorView) => { v.dispatch({ effects: toggleDim.of(!v.state.field(dimOn)) }); return true },
}

export const nest = [
  nestField, growStack, dimOn,
  rails, dim,
  showPanel.of(crumbs),
  folding,
]
