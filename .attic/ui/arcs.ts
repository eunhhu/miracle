// 줄 왼쪽 여백에 참조 선을 그린다.
// - 이름 위: 정의 ↔ 쓰인 곳
// - 블록 안 (이름 아님): 이 블록 → 이 블록이 쓰는 블록, 이 블록을 쓰는 블록 → 이 블록
// 숫자 끌기도 여기: 숫자를 좌우로 끌면 값이 바뀐다.

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { world, hereField, rootAt } from './state'
import { graphOf } from './inline'

const NS = 'http://www.w3.org/2000/svg'

export const arcs = ViewPlugin.fromClass(class {
  svg: SVGSVGElement
  constructor(readonly view: EditorView) {
    this.svg = document.createElementNS(NS, 'svg')
    this.svg.classList.add('arcs')
    view.scrollDOM.appendChild(this.svg)
    this.schedule()
  }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.geometryChanged || u.viewportChanged) this.schedule()
  }
  schedule() {
    this.view.requestMeasure({ read: v => this.measure(v), write: (m) => this.draw(m) })
  }
  measure(view: EditorView) {
    const s = view.state
    const { a, syms } = s.field(world)
    const h = s.field(hereField)
    const doc = s.doc
    const top = (no: number) => {
      const l = doc.line(Math.min(no + 1, doc.lines))
      const b = view.lineBlockAt(l.from)
      return b.top + b.height / 2
    }
    const base = view.contentDOM.getBoundingClientRect().left - view.scrollDOM.getBoundingClientRect().left + view.scrollDOM.scrollLeft
    const pairs: { a: number; b: number; cls: string }[] = []
    const cur = doc.lineAt(s.selection.main.head).number - 1
    if (h.def && h.refs.length > 1) {
      const d = doc.lineAt(h.def.from).number - 1
      const seen = new Set<number>([d])
      for (const r of h.refs) {
        const l = doc.lineAt(Math.min(r.from, doc.length)).number - 1
        if (seen.has(l)) continue
        seen.add(l)
        // 같은 블록 안 가까운 줄은 강조만으로 충분
        if (rootAt(a, l) === rootAt(a, d) && Math.abs(l - d) < 4) continue
        pairs.push({ a: d, b: l, cls: 'arc-ref' })
      }
    } else {
      const r = rootAt(a, cur)
      if (r) {
        const g = graphOf(a, syms)
        for (const t of g.out.get(r) ?? []) pairs.push({ a: r.line.no, b: t.line.no, cls: 'arc-out' })
        for (const [src, k] of g.in.get(r) ?? []) pairs.push({ a: src.line.no, b: r.line.no, cls: k === 'w' ? 'arc-in-w' : 'arc-in' })
      }
    }
    const height = view.contentHeight + view.documentPadding.top
    return { base, height, paths: pairs.map(p => ({ y1: top(p.a) + view.documentPadding.top, y2: top(p.b) + view.documentPadding.top, cls: p.cls })) }
  }
  draw(m: { base: number; height: number; paths: { y1: number; y2: number; cls: string }[] }) {
    const svg = this.svg
    svg.style.left = `${m.base - 26}px`
    svg.style.height = `${m.height}px`
    svg.setAttribute('width', '26')
    svg.setAttribute('height', String(m.height))
    svg.replaceChildren()
    // 멀수록 바깥으로 휘게
    const sorted = [...m.paths].sort((x, y) => Math.abs(x.y2 - x.y1) - Math.abs(y.y2 - y.y1))
    sorted.forEach((p, i) => {
      const bend = Math.min(22, 6 + i * 3 + Math.abs(p.y2 - p.y1) / 60)
      const x = 24
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', `M ${x} ${p.y1} C ${x - bend} ${p.y1}, ${x - bend} ${p.y2}, ${x} ${p.y2}`)
      path.setAttribute('class', `arc ${p.cls}`)
      svg.appendChild(path)
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(p.y2)); dot.setAttribute('r', '2.2')
      dot.setAttribute('class', `arc-dot ${p.cls}`)
      svg.appendChild(dot)
    })
  }
  destroy() { this.svg.remove() }
})

// ── 숫자 끌기 · 참/거짓 누르기 ──────────────────────────

const NUM = /-?\d+(\.\d+)?/g

function numberAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos)
  const t = line.text.replace(/\/\/.*$/, '')
  for (const m of t.matchAll(NUM)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    const prev = t[m.index! - 1]
    if (prev && /[\p{L}_]/u.test(prev)) continue // 이름 안 숫자
    if (pos >= from && pos <= to) return { from, to, text: m[0] }
  }
}

export const scrub = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return false
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos === null) return false
    const n = numberAt(view, pos)
    if (!n) return false
    const startX = e.clientX
    const base = Number(n.text)
    const dec = n.text.includes('.') ? n.text.split('.')[1].length : 0
    const step = dec ? 10 ** -dec : Math.abs(base) >= 1000 ? 100 : Math.abs(base) >= 100 ? 10 : 1
    let range = { from: n.from, to: n.to }
    let dragging = false
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < 4) return
      if (!dragging) { dragging = true; document.body.classList.add('scrubbing') }
      const v = (base + Math.round(dx / 8) * step).toFixed(dec)
      if (v === view.state.sliceDoc(range.from, range.to)) return
      view.dispatch({ changes: { from: range.from, to: range.to, insert: v }, selection: { anchor: range.from + v.length }, userEvent: 'input.scrub' })
      range = { from: range.from, to: range.from + v.length }
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('scrubbing')
      if (!dragging) {
        const p = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? pos
        view.dispatch({ selection: { anchor: p } })
      }
      view.focus()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    e.preventDefault()
    return true
  },
})

/** 숫자 위 커서: ew-resize */
export const scrubCursor = EditorView.domEventHandlers({
  mousemove(e, view) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    view.contentDOM.style.cursor = pos !== null && numberAt(view, pos) ? 'ew-resize' : ''
    return false
  },
})
