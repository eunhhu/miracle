// 블록: 커서가 있는 덩어리는 떠오르고, 그 아래에 미리보기가 펼쳐진다.
import { EditorView, ViewPlugin, layer, type LayerMarker, type ViewUpdate } from '@codemirror/view'
import { StateField, type EditorState } from '@codemirror/state'
import { live, bump } from './live'
import type { Block } from '../core/analyze'
import { renderPreview } from './preview'

export function blockAt(state: EditorState, line0: number): Block | undefined {
  const { a } = state.field(live)
  return a.blocks.find(b => line0 >= b.from && line0 <= b.to)
}

export const focusBlock = StateField.define<Block | undefined>({
  create: s => blockAt(s, s.doc.lineAt(s.selection.main.head).number - 1),
  update(v, tr) {
    if (!tr.docChanged && !tr.selection && tr.startState.field(live) === tr.state.field(live)) return v
    const b = blockAt(tr.state, tr.state.doc.lineAt(tr.state.selection.main.head).number - 1)
    if (v && b && v.from === b.from && v.to === b.to && v.name === b.name && v.node === b.node) return v
    return b
  },
})

// ── 판: 블록마다 얇은 판, 커서 블록은 떠오른 판 ──
class Slab implements LayerMarker {
  constructor(readonly top: number, readonly height: number, readonly left: number, readonly width: number, readonly on: boolean, readonly kind: string) {}
  eq(o: Slab) { return o.top === this.top && o.height === this.height && o.left === this.left && o.width === this.width && o.on === this.on && o.kind === this.kind }
  draw() { const d = document.createElement('div'); this.paint(d); return d }
  update(d: HTMLElement) { this.paint(d); return true }
  paint(d: HTMLElement) {
    d.className = `slab k-${this.kind}${this.on ? ' on' : ''}`
    Object.assign(d.style, { top: `${this.top}px`, height: `${this.height}px`, left: `${this.left}px`, width: `${this.width}px` })
  }
}

export const slabs = layer({
  above: false,
  class: 'slabs',
  update: u => u.docChanged || u.selectionSet || u.geometryChanged || u.viewportChanged || u.startState.field(focusBlock) !== u.state.field(focusBlock),
  markers(view) {
    const { a } = view.state.field(live)
    const f = view.state.field(focusBlock)
    const sr = view.scrollDOM.getBoundingClientRect()
    const cr = view.contentDOM.getBoundingClientRect()
    const dy = view.documentTop - sr.top + view.scrollDOM.scrollTop
    const left = cr.left - sr.left + view.scrollDOM.scrollLeft + 6
    const width = Math.min(cr.width - 6, 1000)
    const out: Slab[] = []
    const doc = view.state.doc
    const { from: vf, to: vt } = view.viewport
    // 붙어 있는 한 줄짜리 선언들은 한 판으로
    const groups: { from: number; to: number; kind: string; name: string }[] = []
    for (const b of a.blocks) {
      if (b.node.kind === 'use') continue
      const g = groups[groups.length - 1]
      const kind = b.node.kind === 'call' ? b.name : b.node.kind
      if (g && kind === 'decl' && g.kind === 'decl' && g.to + 1 === b.from && b.from === b.to) { g.to = b.to; continue }
      groups.push({ from: b.from, to: b.to, kind, name: b.name })
    }
    for (const b of groups) {
      const s = doc.line(b.from + 1), e = doc.line(Math.min(b.to + 1, doc.lines))
      if (e.to < vf || s.from > vt) continue
      const top = view.lineBlockAt(s.from).top
      const bottom = view.lineBlockAt(e.from).bottom
      const on = !!f && f.from >= b.from && f.from <= b.to
      out.push(new Slab(top + dy - 6, bottom - top + 12, left, width, on, b.kind))
    }
    return out
  },
})

// ── 미리보기 (캐시) ──
interface Cached { el: HTMLElement; sig: string }
const cache = new Map<string, Cached>()
export const clearPreviewCache = () => cache.clear()

let hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }
void (hash = hash)

/** 미리보기 판: 캐시해 두고, 같은 블록·같은 상태면 그대로 다시 쓴다 */
function previewEl(view: EditorView, key: string, sig: string, b: Block): HTMLElement {
  const c = cache.get(key)
  if (c && c.sig === sig) return c.el
  const el = c?.el ?? document.createElement('div')
  el.className = c ? 'pv-host' : 'pv-host fresh'
  const active = document.activeElement as HTMLInputElement | null
  const keep = active && el.contains(active) ? { k: active.dataset.k, s: active.selectionStart, e: active.selectionEnd } : undefined
  renderPreview(el, view, b)
  if (keep?.k) {
    const n = el.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(keep.k)}"]`)
    if (n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e) } catch { /* */ } }
  }
  cache.set(key, { el, sig })
  return el
}

// 미리보기는 코드 줄 사이에 끼지 않는다: 블록 오른쪽에 떠 있는 판.
// 줄 높이·위치를 바꾸지 않으니 ↑↓ 이동·스크롤이 미리보기 때문에 흔들리지 않는다.
export const previewDeco = ViewPlugin.fromClass(class {
  dock: HTMLElement
  cur?: { key: string; sig: string }
  constructor(readonly view: EditorView) {
    this.dock = document.createElement('div')
    this.dock.className = 'pv-dock'
    this.dock.hidden = true
    // 판 안의 클릭·입력은 에디터 커서를 옮기지 않는다
    for (const ev of ['mousedown', 'pointerdown', 'click', 'keydown', 'wheel'] as const)
      this.dock.addEventListener(ev, e => { if (ev !== 'wheel') e.stopPropagation() })
    view.scrollDOM.appendChild(this.dock)
    new ResizeObserver(() => { if (!this.dock.hidden) this.place() }).observe(this.dock)
    this.sync()
  }
  update(u: ViewUpdate) {
    // 세계가 바뀌는 사건(bump)은 live 객체를 그대로 둘 수 있으니, 트랜잭션이 있으면 늘 서명을 비교한다
    if (u.transactions.length || u.geometryChanged || u.viewportChanged) this.sync()
  }
  sync() {
    const view = this.view, s = view.state
    const b = s.field(focusBlock)
    if (!b || b.node.kind === 'use') { this.cur = undefined; this.dock.hidden = true; return }
    const { w, file } = s.field(live)
    const key = `${file}:${b.node.kind}:${b.name}`
    const sig = `${hash(s.doc.toString())}:${w.version}:${[...w.failLines].join(',')}:${w.log.length}`
    if (this.cur?.key !== key || this.cur.sig !== sig) {
      const el = previewEl(view, key, sig, b)
      if (this.dock.firstChild !== el) this.dock.replaceChildren(el)
      this.cur = { key, sig }
      requestAnimationFrame(() => el.classList.remove('fresh'))
    }
    this.place()
  }
  place() {
    const view = this.view
    const b = view.state.field(focusBlock)
    if (!b || b.node.kind === 'use') return
    view.requestMeasure({
      key: this,
      read: v => {
        const doc = v.state.doc
        const sl = doc.line(b.from + 1), el = doc.line(Math.min(b.to + 1, doc.lines))
        const sr = v.scrollDOM.getBoundingClientRect()
        // 블록에서 가장 긴 줄(줄 끝 값 포함)의 오른쪽
        let right = 0
        for (let i = b.from + 1; i <= Math.min(b.to + 1, doc.lines); i++) {
          const line = doc.line(i)
          if (line.from < v.viewport.from || line.from > v.viewport.to) continue
          const dom = v.domAtPos(line.from).node
          const ln = (dom.nodeType === 1 ? dom as HTMLElement : dom.parentElement)?.closest('.cm-line')
          if (!ln) continue
          const r = document.createRange(); r.selectNodeContents(ln)
          right = Math.max(right, r.getBoundingClientRect().right)
        }
        const top = v.lineBlockAt(sl.from).top + v.documentTop - sr.top + v.scrollDOM.scrollTop
        const bottom = v.lineBlockAt(el.from).bottom + v.documentTop - sr.top + v.scrollDOM.scrollTop
        // 실제로 보이는 구간 (스크롤러가 창보다 길 수도 있고, 아래 상태줄에 가릴 수도 있다)
        const foot = document.querySelector('#keys')?.getBoundingClientRect().top ?? innerHeight
        const visTop = Math.max(sr.top, 0), visBot = Math.min(sr.bottom, innerHeight, foot)
        return { right: right - sr.left + v.scrollDOM.scrollLeft, top, bottom, width: v.scrollDOM.clientWidth, scrollTop: visTop - sr.top + v.scrollDOM.scrollTop, height: Math.max(160, visBot - visTop) }
      },
      write: m => {
        const W = Math.min(460, Math.max(320, m.width - m.right - 56))
        const left = Math.min(m.right + 40, m.width - W - 16)
        // 블록이 위로 반쯤 올라가도 판은 화면 안에 붙어 있는다 (블록 끝까지만)
        this.dock.hidden = false
        Object.assign(this.dock.style, { width: `${W}px`, maxHeight: `${m.height - 28}px` })
        const h = Math.min(this.dock.scrollHeight || 200, m.height - 28)
        let top = Math.max(m.top - 6, Math.min(m.scrollTop + 12, m.bottom - Math.min(h, 120)))
        // 화면 아래로 넘치면 올린다 (화면 위는 넘지 않게)
        top = Math.max(m.scrollTop + 12, Math.min(top, m.scrollTop + m.height - h - 16))
        Object.assign(this.dock.style, { left: `${Math.max(0, left)}px`, top: `${top}px`, width: `${W}px` })
        this.dock.classList.toggle('over', m.right + 40 > m.width - W - 16)
        this.dock.hidden = false
      },
    })
  }
  destroy() { this.dock.remove() }
})

/** 세계가 사건으로 바뀌면 에디터에 알린다 */
export function watchWorld(view: EditorView) {
  let last: unknown
  const hook = () => {
    const w = view.state.field(live, false)?.w
    if (w && last !== w) {
      last = w
      w.listeners.add(() => queueMicrotask(() => view.dispatch({ effects: bump.of(w.version) })))
    }
  }
  hook()
  return EditorView.updateListener.of(() => hook())
}
