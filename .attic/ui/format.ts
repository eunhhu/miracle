// 손이 신경 쓰지 않아도 되는 것들: 들여쓰기, 칸 맞춤, 빈 줄에서 밖으로 나가기

import { EditorSelection, type ChangeSpec, type EditorState, type Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Command } from '@codemirror/view'

const OPENERS = new Set(['model', 'interface', 'component', 'system', 'sample', 'app', 'screen', 'card', 'row', 'stack', 'col', 'list', 'when', 'else', 'for'])
const indentOf = (t: string) => /^ */.exec(t)![0].length

/** 이 줄 다음 줄은 안으로 들어가야 하나 */
function opens(text: string) {
  const t = text.replace(/\s*\/\/.*$/, '').trim()
  if (!t) return false
  const head = t.split(/\s+/)[0]
  return OPENERS.has(head)
}

/**
 * ↵
 * - 블록을 여는 줄 끝: 안으로 한 칸 들어간 새 줄
 * - 들여쓴 빈 줄: 한 칸 밖으로 (아웃라이너처럼)
 * - 그 밖: 같은 깊이 새 줄
 */
export const smartEnter: Command = view => {
  const s = view.state
  const sel = s.selection.main
  if (!sel.empty) return false
  const line = s.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  const ind = indentOf(line.text)

  if (!line.text.trim() && ind > 0) {
    const to = Math.max(0, ind - 2)
    view.dispatch({ changes: { from: line.from, to: line.to, insert: ' '.repeat(to) }, selection: { anchor: line.from + to }, userEvent: 'input.outdent' })
    return true
  }
  if (sel.head - line.from < ind) return false
  const next = opens(before) && !after.trim() ? ind + 2 : ind
  const insert = '\n' + ' '.repeat(next)
  view.dispatch({
    changes: { from: sel.head, to: sel.head + (after.length - after.trimStart().length), insert },
    selection: { anchor: sel.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

// ── 칸 맞춤 ─────────────────────────────────────────────

/** 한글·한자는 두 칸 */
const width = (s: string) => [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)))

/** 따옴표·괄호 안 공백은 자르지 않는다 */
function words(s: string): string[] {
  const out: string[] = []
  let cur = '', depth = 0, q = false
  for (const c of s) {
    if (q) { cur += c; if (c === '"') q = false; continue }
    if (c === '"') { q = true; cur += c; continue }
    if ('([{'.includes(c)) depth++
    if (')]}'.includes(c)) depth--
    if (c === ' ' && depth <= 0) { if (cur) out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

interface Row { no: number; text: string }

/** model 칸 줄: 이름 · 타입 · 가정/기대 세 칸을 맞춘다 */
function alignFields(rows: Row[], ind: number): Map<number, string> {
  const out = new Map<number, string>()
  type F = { no: number; name: string; derived?: string; type?: string; tail?: string; comment: string }
  const fs: F[] = []
  for (const r of rows) {
    const m = /^(.*?)(\s*\/\/.*)?$/.exec(r.text.trim())!
    const body = m[1].trim()
    const comment = m[2] ? '   ' + m[2].trim() : ''
    const d = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u.exec(body)
    if (d && !d[2].startsWith('=')) {
      const t = splitTail(d[2])
      fs.push({ no: r.no, name: d[1], derived: t.main, tail: t.tail, comment })
      continue
    }
    const w = words(body)
    if (w.length < 2) return out
    const t = splitTail(w.slice(1).join(' '))
    fs.push({ no: r.no, name: w[0], type: t.main, tail: t.tail, comment })
  }
  const nameW = Math.max(...fs.map(f => width(f.name)))
  const typeW = Math.max(0, ...fs.filter(f => f.type && f.tail).map(f => width(f.type!)))
  for (const f of fs) {
    let s = ' '.repeat(ind)
    if (f.derived !== undefined) s += pad(f.name, nameW) + ' = ' + f.derived + (f.tail ? '   ' + f.tail : '')
    else s += pad(f.name, nameW) + '  ' + (f.tail ? pad(f.type!, typeW) + '   ' + f.tail : f.type)
    out.set(f.no, s + f.comment)
  }
  return out
}

function splitTail(s: string) {
  const i = s.search(/(^|\s)[?!](\s|$)/)
  if (i < 0) return { main: s.trim(), tail: undefined }
  return { main: s.slice(0, i).trim(), tail: s.slice(i).trim().replace(/^([?!])\s+/, '$1 ') }
}

/** `? 이름  칸=값 …` 줄들: 칸마다 세로로 맞춘다 */
function alignInstances(rows: Row[], ind: number): Map<number, string> {
  const out = new Map<number, string>()
  const cells = rows.map(r => {
    const m = /^(.*?)(\s*\/\/.*)?$/.exec(r.text.trim())!
    return { no: r.no, w: words(m[1].trim().replace(/^\?\s*/, '')), comment: m[2] ? '   ' + m[2].trim() : '' }
  })
  const cols = Math.max(...cells.map(c => c.w.length))
  const ws: number[] = []
  for (let j = 0; j < cols; j++) ws[j] = Math.max(...cells.map(c => c.w[j] ? width(c.w[j]) : 0))
  for (const c of cells) out.set(c.no, ' '.repeat(ind) + '? ' + c.w.map((x, j) => j === c.w.length - 1 ? x : pad(x, ws[j])).join('  ') + c.comment)
  return out
}

/** 줄(1부터)이 속한 형제 묶음을 찾아 맞춘 결과를 변경으로 */
export function alignAround(state: EditorState, lineNo: number): ChangeSpec[] {
  const doc = state.doc
  if (lineNo < 1 || lineNo > doc.lines) return []
  const text = doc.line(lineNo).text
  const ind = indentOf(text)
  const t = text.trim()
  const changes: ChangeSpec[] = []
  // 끝 공백
  if (text !== text.trimEnd() && t) changes.push({ from: doc.line(lineNo).from + text.trimEnd().length, to: doc.line(lineNo).to })
  if (!t || ind === 0) return changes
  // 부모가 model 인지
  let parent = ''
  for (let i = lineNo - 1; i >= 1; i--) {
    const pt = doc.line(i).text
    if (pt.trim() && indentOf(pt) < ind) { parent = pt.trim(); break }
  }
  if (!/^model\s/.test(parent)) return changes
  const isInst = (s: string) => s.trim().startsWith('?')
  const isField = (s: string) => !!s.trim() && !isInst(s) && !/^(check|\/\/)/.test(s.trim())
  const kind = isInst(t) ? isInst : isField(t) ? isField : null
  if (!kind) return changes
  // 같은 깊이 · 같은 종류로 이어지는 줄들
  let a = lineNo, b = lineNo
  while (a > 1 && indentOf(doc.line(a - 1).text) === ind && kind(doc.line(a - 1).text)) a--
  while (b < doc.lines && indentOf(doc.line(b + 1).text) === ind && kind(doc.line(b + 1).text)) b++
  const rows: Row[] = []
  for (let i = a; i <= b; i++) rows.push({ no: i, text: doc.line(i).text })
  const next = kind === isInst ? alignInstances(rows, ind) : alignFields(rows, ind)
  changes.length = 0
  for (const r of rows) {
    const n = next.get(r.no)
    if (n !== undefined && n !== r.text) changes.push({ from: doc.line(r.no).from, to: doc.line(r.no).to, insert: n })
  }
  return changes
}

/** 커서가 줄을 떠나면 그 줄 묶음을 맞춘다 */
export const alignOnLeave = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) {}
  update(u: ViewUpdate) {
    if (!u.selectionSet || u.transactions.some(t => t.isUserEvent('align'))) return
    const prev = u.startState.doc.lineAt(u.startState.selection.main.head).number
    const now = u.state.doc.lineAt(u.state.selection.main.head).number
    if (prev === now) return
    // 문서가 바뀌었으면 옛 줄 번호를 새 문서로 옮긴다
    const pos = u.changes.mapPos(u.startState.doc.line(prev).from, 1)
    const line = u.state.doc.lineAt(pos).number
    queueMicrotask(() => {
      const changes = alignAround(this.view.state, line)
      if (changes.length) this.view.dispatch({ changes, userEvent: 'align' })
    })
  }
})

/** 전체 맞춤 (⌘S) */
export const alignAll: Command = view => {
  const s = view.state
  const done = new Set<number>()
  const all: ChangeSpec[] = []
  for (let i = 1; i <= s.doc.lines; i++) {
    if (done.has(i)) continue
    const ch = alignAround(s, i)
    for (const c of ch as { from: number }[]) done.add(s.doc.lineAt(c.from).number)
    all.push(...ch)
  }
  // 겹치는 변경 제거
  const seen = new Set<number>()
  const uniq = (all as { from: number; to: number }[]).filter(c => !seen.has(c.from) && seen.add(c.from))
  if (uniq.length) view.dispatch({ changes: uniq, userEvent: 'align' })
  return true
}

export { EditorSelection, type Transaction }
