// 이름 바꾸기와 한꺼번에 고치기. 둘 다 "따라가기"(trace)가 찾은 곳을 그대로 쓴다.
//
// · 정의 이름을 고치면 쓰는 곳이 같이 바뀐다 (Esc = 이번엔 여기만).
//   다른 파일이 그 이름을 쓰고 있으면, 커서가 정의를 떠날 때 그 파일들도 고친다.
// · F2 = 같은 것 전부에 커서. ⌘E 를 누를 때마다 범위가 바뀐다:
//   전부 → 바꾸는 곳(줄) → 읽는 곳 → 부르는 곳 끝(인자 덧붙이기)
import { EditorView, Decoration, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorSelection, StateEffect, StateField, EditorState, Annotation, type Transaction, type TransactionSpec } from '@codemirror/state'
import { live } from './live'
import { symAt } from './lens'
import { occurrences, renamable, sameSym } from './trace'
import type { Sym } from '../core/analyze'
import { keyLabel } from './keys'

interface Link { ranges: { from: number; to: number }[]; orig: string; sym: Sym; file?: string }

let usersOf: (file: string, name: string) => string[] = () => []
export function setUsersOf(f: typeof usersOf) { usersOf = f }

const mirrored = Annotation.define<boolean>()
const unlink = StateEffect.define<null>()
const muteAt = StateEffect.define<number | null>()

function linkFor(s: EditorState, muted: number | null): Link | null {
  const r = s.selection.main
  if (s.selection.ranges.length > 1) return null
  const { a, file } = s.field(live)
  const hit = symAt(s, r.head)
  if (!hit || !renamable(hit.sym) || hit.sym.file || hit.sym.from < 0) return null
  const sym = hit.sym
  if (!(sym.from <= r.from && r.to <= sym.to)) return null       // 정의 위에서만
  if (muted === sym.from) return null
  const occ = occurrences(s, sym)
  const name = s.doc.sliceString(sym.from, sym.to)
  if (occ.length < 2 && !(file && usersOf(file, name).length)) return null
  const ranges = [{ from: sym.from, to: sym.to }, ...occ.filter(o => o.from !== sym.from && s.doc.sliceString(o.from, o.to) === name).map(o => ({ from: o.from, to: o.to }))]
  void a
  return { ranges, orig: name, sym, file }
}

const muteField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(muteAt)) return e.value
    if (v === null) return v
    const m = tr.changes.mapPos(v)
    const h = tr.state.selection.main.head
    const l = tr.state.doc.lineAt(m)
    return h >= l.from && h <= l.to ? m : null
  },
})

export const linkField = StateField.define<Link | null>({
  create: s => linkFor(s, null),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(unlink)) return null
    const muted = tr.state.field(muteField)
    if (v && tr.docChanged) {
      v = { ...v, ranges: v.ranges.map(r => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) })) }
      const d = v.ranges[0]
      if (!/^[\p{L}\p{N}_]*$/u.test(tr.state.doc.sliceString(d.from, d.to))) return null
    }
    const h = tr.state.selection.main
    if (v && h.from >= v.ranges[0].from && h.to <= v.ranges[0].to && tr.state.selection.ranges.length === 1) return v
    if (tr.docChanged && v) return null
    return tr.selection || tr.docChanged ? linkFor(tr.state, muted) : v
  },
})

/** 정의 이름 안에서 일어난 고침을 쓰는 곳에도 똑같이 */
const mirror = EditorState.transactionFilter.of((tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged || tr.annotation(mirrored) || !(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr
  const link = tr.startState.field(linkField)
  if (!link) return tr
  const def = link.ranges[0]
  let inside = true
  const ch: { from: number; to: number; text: string }[] = []
  tr.changes.iterChanges((fA, tA, _fB, _tB, ins) => {
    if (fA < def.from || tA > def.to) inside = false
    ch.push({ from: fA - def.from, to: tA - def.from, text: ins.toString() })
  })
  if (!inside || ch.some(c => /[^\p{L}\p{N}_]/u.test(c.text))) return tr
  const extra = link.ranges.slice(1).flatMap(r => ch.map(c => ({ from: r.from + c.from, to: r.from + c.to, insert: c.text })))
  return [tr, { changes: extra, annotations: mirrored.of(true), sequential: false }]
})

// ── 다른 파일까지 ──
type Renamed = (e: { file: string; from: string; to: string; sym: Sym }) => void
let renamed: Renamed = () => {}
export function onRenamed(f: Renamed) { renamed = f }

const commit = ViewPlugin.fromClass(class {
  update(u: ViewUpdate) {
    const before = u.startState.field(linkField), after = u.state.field(linkField)
    if (!before || after) return
    {
      const r0 = before.ranges[0]
      const r = { from: u.changes.mapPos(r0.from, -1), to: u.changes.mapPos(r0.to, 1) }
      const now = (u.state.doc.sliceString(r.from, r.to).match(/^[\p{L}\p{N}_]*/u) ?? [''])[0]
      if (now !== before.orig && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(now) && before.file) {
        const e = { file: before.file, from: before.orig, to: now, sym: before.sym }
        setTimeout(() => renamed(e), 0)
      }
    }
  }
})

// ── 보이기: 같이 바뀌는 곳 점선 + 정의 끝에 알림 ──
class LinkChip extends WidgetType {
  constructor(readonly n: number, readonly files: string) { super() }
  eq(o: LinkChip) { return o.n === this.n && o.files === this.files }
  toDOM() {
    const d = document.createElement('span')
    d.className = 'link-chip'
    const where = [this.n ? `<b>${this.n}곳</b>` : '', this.files ? `<i>${this.files}</i>` : ''].filter(Boolean).join(' · ')
    d.innerHTML = `${where} 같이 바뀜 <kbd>Esc</kbd> 여기만`
    return d
  }
  ignoreEvent() { return true }
}

const linkDeco = EditorView.decorations.compute([linkField], s => {
  const l = s.field(linkField)
  if (!l) return Decoration.none
  const marks = l.ranges.map((r, i) => Decoration.mark({ class: i ? 'cm-linked' : 'cm-linked def' }).range(r.from, Math.max(r.to, r.from)))
  const live = marks.filter(m => m.from < m.to)
  const d = l.ranges[0]
  if (s.doc.sliceString(d.from, d.to) === l.orig) return Decoration.set(live, true)
  const others = l.file ? usersOf(l.file, l.orig) : []
  const end = s.doc.lineAt(d.to).to
  return Decoration.set([...live, Decoration.widget({ widget: new LinkChip(l.ranges.length - 1, others.join(', ')), side: 1 }).range(end)], true)
})

// ── 한꺼번에 고르기 ──
type Mode = 'all' | 'writes' | 'reads' | 'calls'
const MODE_WORD: Record<Mode, string> = { all: '전부', writes: '바꾸는 줄', reads: '읽는 곳', calls: '부르는 곳 끝' }
interface Bulk { mode: Mode; n: number; next?: Mode; sym: Sym }
const setBulk = StateEffect.define<Bulk | null>()
export const bulkField = StateField.define<Bulk | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setBulk)) return e.value
    if (tr.selection && tr.state.selection.ranges.length < 2) return null
    return v
  },
})

function modesFor(sym: Sym): Mode[] {
  const out: Mode[] = ['all']
  if (sym.kind === 'decl' || sym.kind === 'local' || sym.kind === 'field') out.push('writes', 'reads')
  if (sym.kind === 'fn' || sym.kind === 'comp' || sym.kind === 'model') out.push('calls')
  return out
}

function select(view: EditorView, sym: Sym, mode: Mode, anchorPos: number): boolean {
  const s = view.state
  const occ = occurrences(s, sym)
  let ranges: { from: number; to: number }[] = []
  const lineBody = (pos: number) => {
    const l = s.doc.lineAt(pos)
    const t = l.text
    const start = l.from + (t.length - t.trimStart().length)
    const cut = t.search(/\s+(\?|!|\/\/)\s/)
    return { from: start, to: cut > 0 ? l.from + cut : l.to }
  }
  if (mode === 'all') ranges = occ
  else if (mode === 'writes') ranges = occ.filter(o => o.kind === 'w').map(o => lineBody(o.from))
  else if (mode === 'reads') ranges = occ.filter(o => o.kind === 'r')
  else if (mode === 'calls') ranges = occ.filter(o => o.kind !== 'def').map(o => { const b = lineBody(o.from); return { from: b.to, to: b.to } })
  const seen = new Set<number>()
  ranges = ranges.filter(r => !seen.has(r.from) && seen.add(r.from))
  if (!ranges.length) return false
  let main = ranges.findIndex(r => r.from <= anchorPos && anchorPos <= r.to)
  if (main < 0) main = ranges.findIndex(r => s.doc.lineAt(r.from).number === s.doc.lineAt(anchorPos).number)
  const modes = modesFor(sym)
  const next = modes[(modes.indexOf(mode) + 1) % modes.length]
  view.dispatch({
    selection: EditorSelection.create(ranges.map(r => EditorSelection.range(r.from, r.to)), Math.max(0, main)),
    effects: [setBulk.of({ mode, n: ranges.length, next: next === mode ? undefined : next, sym }), unlink.of(null)],
    scrollIntoView: true,
  })
  return true
}

/** F2: 이 이름이 나오는 곳 전부 */
export function renameAll(view: EditorView): boolean {
  const s = view.state
  const hit = symAt(s, s.selection.main.head)
  if (!hit || !renamable(hit.sym)) return false
  return select(view, hit.sym, 'all', s.selection.main.head)
}

/** ⌘E: 누를 때마다 범위가 바뀐다 */
export function bulkNext(view: EditorView): boolean {
  const s = view.state
  const b = s.field(bulkField)
  if (b && b.next) return select(view, b.sym, b.next, s.selection.main.head)
  if (b) return select(view, b.sym, 'all', s.selection.main.head)
  const hit = symAt(s, s.selection.main.head)
  if (!hit || !renamable(hit.sym)) return false
  return select(view, hit.sym, 'all', s.selection.main.head)
}

/** Esc: 같이 바뀌기 끄기 */
export function escapeLink(view: EditorView): boolean {
  const l = view.state.field(linkField)
  if (!l) return false
  view.dispatch({ effects: [muteAt.of(l.ranges[0].from), unlink.of(null)] })
  return true
}

class BulkChip extends WidgetType {
  constructor(readonly b: Bulk) { super() }
  eq(o: BulkChip) { return o.b.mode === this.b.mode && o.b.n === this.b.n }
  toDOM() {
    const d = document.createElement('span')
    d.className = 'link-chip bulk'
    d.innerHTML = `<b>${this.b.sym.name}</b> ${MODE_WORD[this.b.mode]} <b>${this.b.n}</b>` + (this.b.next ? ` · <kbd>${keyLabel('Mod-e')}</kbd> ${MODE_WORD[this.b.next]}` : '') + ' · <kbd>Esc</kbd> 하나로'
    return d
  }
  ignoreEvent() { return true }
}
const bulkDeco = EditorView.decorations.compute([bulkField, 'selection'], s => {
  const b = s.field(bulkField)
  if (!b) return Decoration.none
  const end = s.doc.lineAt(s.selection.main.head).to
  return Decoration.set([Decoration.widget({ widget: new BulkChip(b), side: 2 }).range(end)])
})

export const refactor = [muteField, linkField, mirror, commit, linkDeco, bulkField, bulkDeco]
export type { DecorationSet }
