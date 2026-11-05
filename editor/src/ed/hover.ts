// 이름 위에 마우스를 올리면(또는 ⌘I) 그게 뭔지 한 장으로: 종류 · 타입 · 객체 모양 · 지금 값 · 쓰이는 곳.
import { EditorView, hoverTooltip, showTooltip, keymap, type Tooltip } from '@codemirror/view'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { live } from './live'
import { symAt, describe } from './lens'
import { occurrences, sameSym } from './trace'
import { fmt, type V } from '../core/run'
import type { Sym, Analysis } from '../core/analyze'

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const BASE = new Set(['Number', 'Text', 'Bool', 'Time', 'Id'])

function typeHtml(name: string, list: boolean) {
  return `<span class="hv-t ${BASE.has(name) ? 'base' : 'model'}">${esc(name)}</span>${list ? '<span class="hv-p">[]</span>' : ''}`
}

/** 모델 모양: 칸 이름 · 타입, 계산 칸은 = 식 */
function shapeHtml(a: Analysis, model: string, value: V | undefined, depth = 0): string {
  const fields = a.fieldsOf(model)
  if (!fields.length) return ''
  const rows = fields.map(f => {
    const t = a.typeOf(f)
    const comp = f.kind === 'computed'
    const raw = comp ? f.node?.line.text.slice(f.node.line.text.indexOf('=') + 1).trim() : undefined
    const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as any)[f.name] : undefined
    const nested = t && !BASE.has(t.name) && depth < 1 && a.fieldsOf(t.name).length ? `<div class="hv-nest">${shapeHtml(a, t.name, t.list ? undefined : v, depth + 1)}</div>` : ''
    return `<div class="hv-f${comp ? ' comp' : ''}"><b>${esc(f.name)}</b>${t ? typeHtml(t.name, t.list) : ''}${raw ? `<span class="hv-eq">= ${esc(raw)}</span>` : ''}${v !== undefined && !nested ? `<span class="hv-v">${esc(fmt(v, 2))}</span>` : ''}</div>${nested}`
  }).join('')
  return `<div class="hv-shape" role="list" aria-label="${esc(model)} 의 칸">${rows}</div>`
}

function valueOf(state: EditorState, s: Sym): V | undefined {
  if (s.kind !== 'decl') return
  const p = state.field(live).w.peek(s.name)
  return p.ok ? p.v : undefined
}

export function cardFor(state: EditorState, s: Sym): HTMLElement {
  const { a } = state.field(live)
  const d = describe(a, state, s)
  const t = a.typeOf(s)
  const v = valueOf(state, s)
  const el = document.createElement('div')
  el.className = `hv k-${s.kind}`
  el.setAttribute('role', 'tooltip')
  let html = `<div class="hv-head"><b class="hv-name">${esc(s.name)}</b>${t ? typeHtml(t.name, t.list) : ''}<span class="hv-kind">${esc(d.kind)}</span></div>`
  // 값
  const modelName0 = s.kind === 'model' ? s.name : t && !BASE.has(t.name) ? t.name : undefined
  if (v !== undefined) {
    const n = Array.isArray(v) ? `<span class="hv-count">${v.length}개</span>` : ''
    // 모양 표에 값이 같이 나오면 한 줄 요약은 개수만
    const body = modelName0 && a.fieldsOf(modelName0).length ? (Array.isArray(v) ? (v.length ? '' : '비어 있음') : '') : fmt(v, 1)
    if (n || body) html += `<div class="hv-val">${n}${body ? `<code>${esc(body)}</code>` : ''}</div>`
  } else if (d.value && s.kind !== 'decl') html += `<div class="hv-val"><code>${esc(d.value.replace(/<[^>]+>/g, ''))}</code></div>`
  // 모양
  const modelName = s.kind === 'model' ? s.name : t && !BASE.has(t.name) ? t.name : undefined
  if (modelName) {
    const first = Array.isArray(v) ? v[0] : v
    const sh = shapeHtml(a, modelName, first)
    if (sh) html += `<div class="hv-sec">${t?.list ? `${esc(modelName)} 하나의 모양` : '모양'}${Array.isArray(v) && v.length ? ' · 첫 번째 값' : ''}</div>${sh}`
  }
  // 쓰이는 곳
  if (s.kind !== 'std' && s.kind !== 'builtin') {
    const occ = occurrences(state, s)
    const w = occ.filter(o => o.kind === 'w'), r = occ.filter(o => o.kind === 'r')
    const ln = (xs: typeof occ) => [...new Set(xs.map(o => state.doc.lineAt(o.from).number))]
    const part = (label: string, xs: typeof occ, cls: string) => xs.length ? `<span class="hv-use ${cls}">${label} <b>${xs.length}</b> <i>${ln(xs).slice(0, 6).join(', ')}${ln(xs).length > 6 ? '…' : ''}줄</i></span>` : ''
    const uses = part('바꾸는 곳', w, 'w') + part('읽는 곳', r, 'r')
    if (uses) html += `<div class="hv-uses">${uses}</div>`
  }
  if (d.more && !/^(바꾸는|읽는|쓰는) 곳/.test(d.more)) html += `<div class="hv-more">${esc(d.more)}</div>`
  el.innerHTML = html
  return el
}

// ── 마우스 ──
const mouse = hoverTooltip((view, pos) => {
  const hit = symAt(view.state, pos)
  if (!hit) return null
  return {
    pos: hit.from, end: hit.to, above: true,
    create: () => {
      const dom = cardFor(view.state, hit.sym)
      return { dom }
    },
  }
}, { hoverTime: 260 })

// ── 키보드 (⌘I): 커서 아래 이름 ──
const peek = StateEffect.define<number | null>()
const peekField = StateField.define<Tooltip | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(peek)) {
      if (e.value === null) return null
      const hit = symAt(tr.state, e.value)
      if (!hit) return null
      const sym = hit.sym
      return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom: cardFor(tr.state, sym) }) }
    }
    if (v && (tr.docChanged || tr.selection)) {
      const hit = symAt(tr.state, tr.state.selection.main.head)
      const now = symAt(tr.startState, v.pos)
      if (!hit || !now || !sameSym(hit.sym, now.sym)) return null
    }
    return v
  },
  provide: f => showTooltip.from(f),
})

export function peekHere(view: EditorView): boolean {
  const on = view.state.field(peekField)
  const pos = view.state.selection.main.head
  const hit = symAt(view.state, pos)
  if (!hit) { view.dispatch({ effects: EditorView.announce.of('여긴 이름이 없어') }); return true }
  if (on) { view.dispatch({ effects: peek.of(null) }); return true }
  const card = cardFor(view.state, hit.sym)
  view.dispatch({ effects: [peek.of(pos), EditorView.announce.of(card.innerText.replace(/\s+/g, ' ').slice(0, 300))] })
  return true
}

export const hover = [
  mouse,
  peekField,
  keymap.of([{ key: 'Escape', run: v => { if (!v.state.field(peekField)) return false; v.dispatch({ effects: peek.of(null) }); return true } }]),
]
