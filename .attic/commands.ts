// 커서·토큰·블록 단위 조작
import { EditorSelection, type EditorState, type Transaction } from '@codemirror/state'
import type { EditorView, Command } from '@codemirror/view'
import { splitLines, type Lexeme } from './lang/tokenize'

const indentOf = (s: string) => /^ */.exec(s)![0].length
const isBlank = (s: string) => s.trim() === '' || /^\s*\/\//.test(s)

// ── 토큰 이동 ───────────────────────────────────────────

function stops(state: EditorState): number[] {
  const out: number[] = []
  for (const line of splitLines(state.doc.toString())) {
    for (const l of line.lex) if (l.k !== 'comment') out.push(l.from)
    const end = line.from + line.text.trimEnd().length
    if (!line.blank) out.push(end)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

const tokenMove = (dir: 1 | -1, extend: boolean): Command => view => {
  const ss = stops(view.state)
  view.dispatch(view.state.update({
    selection: EditorSelection.create(view.state.selection.ranges.map(r => {
      const h = r.head
      const to = dir > 0 ? ss.find(p => p > h) ?? view.state.doc.length : [...ss].reverse().find(p => p < h) ?? 0
      return extend ? EditorSelection.range(r.anchor, to) : EditorSelection.cursor(to)
    })),
    scrollIntoView: true,
    userEvent: 'select',
  }))
  return true
}
export const tokenRight = tokenMove(1, false)
export const tokenLeft = tokenMove(-1, false)
export const tokenSelectRight = tokenMove(1, true)
export const tokenSelectLeft = tokenMove(-1, true)

// ── 블록: 줄 + 자식 줄 ──────────────────────────────────

/** 줄 번호(1부터)의 블록 끝 줄 */
function blockEnd(state: EditorState, n: number): number {
  const doc = state.doc
  const ind = indentOf(doc.line(n).text)
  let end = n
  for (let i = n + 1; i <= doc.lines; i++) {
    const t = doc.line(i).text
    if (isBlank(t)) continue
    if (indentOf(t) <= ind) break
    end = i
  }
  return end
}

function prevSibling(state: EditorState, n: number): number | undefined {
  const doc = state.doc
  const ind = indentOf(doc.line(n).text)
  for (let i = n - 1; i >= 1; i--) {
    const t = doc.line(i).text
    if (isBlank(t)) continue
    const k = indentOf(t)
    if (k < ind) return
    if (k === ind) return i
  }
}

function nextSibling(state: EditorState, n: number): number | undefined {
  const doc = state.doc
  const ind = indentOf(doc.line(n).text)
  const i = blockEnd(state, n) + 1
  for (let j = i; j <= doc.lines; j++) {
    const t = doc.line(j).text
    if (isBlank(t)) continue
    return indentOf(t) === ind ? j : undefined
  }
}

/** 블록을 형제 블록과 맞바꾼다 */
const moveBlock = (dir: 1 | -1): Command => view => {
  const st = view.state
  const head = st.selection.main.head
  const n = st.doc.lineAt(head).number
  if (isBlank(st.doc.line(n).text)) return false
  const other = dir < 0 ? prevSibling(st, n) : nextSibling(st, n)
  if (other === undefined) return true
  const [a, b] = dir < 0 ? [other, n] : [n, other]
  const aEnd = blockEnd(st, a), bEnd = blockEnd(st, b)
  const A = { from: st.doc.line(a).from, to: st.doc.line(aEnd).to }
  const B = { from: st.doc.line(b).from, to: st.doc.line(bEnd).to }
  const textA = st.sliceDoc(A.from, A.to), textB = st.sliceDoc(B.from, B.to)
  const gap = st.sliceDoc(A.to, B.from)
  const off = head - st.doc.line(n).from
  const newHead = dir < 0 ? A.from + off : A.from + textB.length + gap.length + (head - A.from)
  view.dispatch({
    changes: { from: A.from, to: B.to, insert: textB + gap + textA },
    selection: { anchor: dir < 0 ? newHead : newHead },
    scrollIntoView: true,
    userEvent: 'move.line',
  })
  void off
  return true
}

// ── 숫자 굴리기 ─────────────────────────────────────────

function numberAt(state: EditorState, pos: number): Lexeme | undefined {
  const line = splitLines(state.doc.toString()).find(l => pos >= l.from && pos <= l.from + l.text.length)
  return line?.lex.find(l => l.k === 'num' && pos >= l.from && pos <= l.to)
}

const nudge = (d: number): Command => view => {
  const lex = numberAt(view.state, view.state.selection.main.head)
  if (!lex) return false
  const m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(lex.text)
  if (!m) return false
  const digits = m[1].split('.')[1]?.length ?? 0
  const step = digits ? Math.pow(10, -digits) : 1
  const next = (Number(m[1]) + d * step).toFixed(digits) + m[2]
  view.dispatch({
    changes: { from: lex.from, to: lex.to, insert: next },
    selection: { anchor: Math.min(view.state.selection.main.head, lex.from + next.length) },
    userEvent: 'input.nudge',
  })
  return true
}

/** ⌥↑: 숫자 위면 +1, 아니면 블록을 위로 */
export const altUp: Command = v => nudge(1)(v) || moveBlock(-1)(v)
export const altDown: Command = v => nudge(-1)(v) || moveBlock(1)(v)

// ── 넓히기 · 좁히기 ─────────────────────────────────────

let history: { from: number; to: number }[] = []
let lastSel = ''

function ranges(state: EditorState, pos: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  const doc = state.doc
  const line = splitLines(doc.toString()).find(l => pos >= l.from && pos <= l.from + l.text.length)
  // 토큰 → 경로 조각
  const lex = line?.lex.find(l => pos >= l.from && pos <= l.to && l.k !== 'comment')
  if (lex) {
    if (lex.k === 'path' || lex.k === 'subj') {
      let off = lex.from
      for (const p of lex.text.split('.')) {
        if (pos >= off && pos <= off + p.length && p) out.push({ from: off, to: off + p.length })
        off += p.length + 1
      }
    }
    out.push({ from: lex.from, to: lex.to })
  }
  // 줄 내용 → 블록 → 부모 블록 …
  let n = doc.lineAt(pos).number
  const l = doc.line(n)
  out.push({ from: l.from + indentOf(l.text), to: l.from + l.text.trimEnd().length })
  while (true) {
    out.push({ from: doc.line(n).from + indentOf(doc.line(n).text), to: doc.line(blockEnd(state, n)).to })
    const ind = indentOf(doc.line(n).text)
    if (ind === 0) break
    let p = n - 1
    while (p >= 1 && (isBlank(doc.line(p).text) || indentOf(doc.line(p).text) >= ind)) p--
    if (p < 1) break
    n = p
  }
  out.push({ from: 0, to: doc.length })
  return out.filter((r, i, arr) => i === 0 || r.from !== arr[i - 1].from || r.to !== arr[i - 1].to)
}

export const expand: Command = view => {
  const sel = view.state.selection.main
  const key = `${sel.from}:${sel.to}`
  if (key !== lastSel) history = []
  const next = ranges(view.state, sel.head).find(r => r.from <= sel.from && r.to >= sel.to && (r.from < sel.from || r.to > sel.to))
  if (!next) return true
  history.push({ from: sel.from, to: sel.to })
  lastSel = `${next.from}:${next.to}`
  view.dispatch({ selection: { anchor: next.from, head: next.to }, userEvent: 'select' })
  return true
}

export const shrink: Command = view => {
  const sel = view.state.selection.main
  if (`${sel.from}:${sel.to}` !== lastSel || !history.length) return true
  const prev = history.pop()!
  lastSel = `${prev.from}:${prev.to}`
  view.dispatch({ selection: { anchor: prev.from, head: prev.to }, userEvent: 'select' })
  return true
}

export type { Transaction }
