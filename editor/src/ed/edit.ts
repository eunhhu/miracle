// 손: 자동 들여쓰기, 그 자리 묶기(⌘G), 정의로 가기.
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { EditorSelection, Prec } from '@codemirror/state'
import { live } from './live'
import { symAt } from './lens'
import { STD } from '../core/std'

const OPEN_KW = /^\s*(model|fn|for|if|else|catch)\b/
const ALWAYS = new Set(['serve', 'route', 'mount', 'app', 'watch', 'every'])
const CONTAINERS = new Set('main div section article header footer nav aside ul ol li form label table tr screen row col stack list card'.split(' '))

function opens(text: string): boolean {
  if (OPEN_KW.test(text)) return true
  const t = text.trim()
  const head = /^([\p{L}_][\p{L}\p{N}_]*)/u.exec(t)?.[1]
  if (!head) return false
  if (ALWAYS.has(head)) return true
  if (CONTAINERS.has(head) && !/"/.test(t)) return true
  return false
}

function enter(view: EditorView): boolean {
  const s = view.state
  const r = s.selection.main
  if (!r.empty) return false
  const line = s.doc.lineAt(r.head)
  const indent = /^ */.exec(line.text)![0].length
  // 빈 줄에서 Enter = 한 칸 밖으로
  if (!line.text.trim() && indent > 0 && r.head === line.to) {
    const n = Math.max(0, indent - 2)
    view.dispatch({ changes: { from: line.from, to: line.to, insert: ' '.repeat(n) }, selection: { anchor: line.from + n }, userEvent: 'input' })
    return true
  }
  const before = line.text.slice(0, r.head - line.from)
  const n = opens(before) && r.head === line.to ? indent + 2 : Math.min(indent, /^ */.exec(before)![0].length || indent)
  const ins = '\n' + ' '.repeat(n)
  view.dispatch({ changes: { from: r.head, to: r.head, insert: ins }, selection: { anchor: r.head + ins.length }, scrollIntoView: true, userEvent: 'input' })
  return true
}

function backspace(view: EditorView): boolean {
  const s = view.state
  const r = s.selection.main
  if (!r.empty) return false
  const line = s.doc.lineAt(r.head)
  const before = line.text.slice(0, r.head - line.from)
  if (before.length && /^ +$/.test(before)) {
    const n = before.length % 2 === 0 ? 2 : 1
    view.dispatch({ changes: { from: r.head - n, to: r.head }, userEvent: 'delete.backward' })
    return true
  }
  return false
}

/** 묶은 줄의 모양을 보고 이름을 지어 준다: for line in cart → CartList, form → …Form */
const SUFFIX: Record<string, string> = {
  ul: 'List', ol: 'List', list: 'List', li: 'Item', form: 'Form', button: 'Button', header: 'Header', footer: 'Footer',
  nav: 'Nav', section: 'Section', article: 'Card', card: 'Card', div: 'Box', main: 'View', p: 'Text', span: 'Text',
  h1: 'Title', h2: 'Title', h3: 'Title', h4: 'Title', input: 'Field', label: 'Field', img: 'Image', table: 'Table', row: 'Row', stack: 'Stack',
}
const cap = (t: string) => t ? t[0].toUpperCase() + t.slice(1) : t
function nameFor(texts: string[], subjects: string[], tops = 1): string {
  const head = texts.find(t => t.trim())?.trim() ?? ''
  const loop = /^for\s+([\p{L}_][\p{L}\p{N}_]*)\s+in\s+([\p{L}_][\p{L}\p{N}_.]*)/u.exec(head)
  if (loop) return cap(loop[2].split('.').pop()!) + 'List'
  const word = /^([\p{L}_][\p{L}\p{N}_]*)/u.exec(head)?.[1] ?? ''
  if (/^[A-Z]/.test(word) && tops === 1) return word + 'Group'
  const suffix = word === 'if' ? 'Section' : tops > 1 ? 'Info' : SUFFIX[word] ?? 'Part'
  const subj = subjects.find(x => /^[\p{L}_]/u.test(x) && /^[a-zA-Z]/.test(x))
  return subj ? cap(subj) + (suffix === 'Part' ? 'View' : suffix) : suffix
}

let toast: (msg: string) => void = () => {}
export const setEditToast = (f: typeof toast) => { toast = f }

/** ⌘G: 고른 줄(없으면 커서가 있는 겹 통째)을 그 자리에서 컴포넌트로.
 *  안에서 쓰는 바깥 이름은 타입까지 붙여 받는 값으로 넘기고, 이름도 모양을 보고 지어 준다. */
export function group(view: EditorView): boolean {
  const s = view.state
  const { a } = s.field(live)
  const r = s.selection.main
  let l1 = s.doc.lineAt(r.from).number - 1
  let l2 = s.doc.lineAt(r.empty ? r.to : Math.max(r.from, r.to - 1)).number - 1
  // 걸친 줄의 자식까지 통째로
  const lines0 = a.tree.lines
  while (l1 <= l2 && lines0[l1]?.blank) l1++
  const baseIndent = lines0[l1]?.indent ?? 0
  while (l2 + 1 < lines0.length && (lines0[l2 + 1].blank ? (lines0[l2 + 2] && !lines0[l2 + 2].blank && lines0[l2 + 2].indent > baseIndent) : lines0[l2 + 1].indent > baseIndent)) l2++
  const top = a.blocks.find(b => l1 >= b.from && l2 <= b.to)
  if (!top || top.node.kind !== 'fn' || l1 === top.from) {
    view.dispatch({ effects: EditorView.announce.of('함수 안의 줄만 묶을 수 있어') })
    toast('함수 안의 줄을 골라야 묶을 수 있어')
    return true
  }
  // 안에서 만든 이름을 밖에서 쓰면 묶으면 깨진다
  {
    const st = s.doc.line(l1 + 1).from, en = s.doc.line(l2 + 1).to
    const leak = a.refs.find(r => (r.from < st || r.to > en) && r.sym.line >= l1 && r.sym.line <= l2 && r.sym.from >= st && r.sym.from <= en)
    if (leak || /^\s*(fn|model)\b/.test(a.tree.lines[l1].text)) {
      const why = leak ? `${leak.sym.name} 을 밖(${s.doc.lineAt(leak.from).number}줄)에서 써서 묶을 수 없어` : '함수·모델 선언은 묶지 않고 화면 줄만 묶어'
      view.dispatch({ effects: EditorView.announce.of(why) }); toast(why)
      return true
    }
  }
  const lines = a.tree.lines.slice(l1, l2 + 1)
  const m = Math.min(...lines.filter(l => !l.blank).map(l => l.indent))
  const start = s.doc.line(l1 + 1).from, end = s.doc.line(l2 + 1).to
  // 밖에서 들어오는 이름: 받는 값 · 이 함수 안 상태 · 하나씩 · 이 안의 함수
  const free = new Map<string, string>()
  const written: string[] = []
  const subjects: string[] = []
  for (const ref of a.refs) {
    if (ref.from < start || ref.to > end) continue
    const k = ref.sym.kind
    if (ref.sym.line >= l1 && ref.sym.line <= l2) continue
    if (k === 'decl' && !subjects.includes(ref.sym.name)) subjects.push(ref.sym.name)
    const inner = ref.sym.line > top.from && ref.sym.line <= top.to
    if (!['local', 'param', 'loop', 'binder', 'catch'].includes(k) && !((k === 'fn' || k === 'comp') && inner)) continue
    let t: string
    if (k === 'fn' || k === 'comp') t = 'fn'
    else { const ti = a.typeOf(ref.sym); t = ti ? ti.name + (ti.list ? '[]' : '') : ref.sym.type?.text ?? 'Text' }
    free.set(ref.sym.name, t)
    if (t !== 'fn' && !subjects.includes(ref.sym.name)) subjects.unshift(ref.sym.name)
    if (ref.write && k !== 'fn' && !written.includes(ref.sym.name)) written.push(ref.sym.name)
  }
  const taken = (n: string) => a.fns.has(n) || a.models.has(n) || a.syms.some(x => x.name === n)
  const tops = lines.filter(l => !l.blank && l.indent === m).length
  const base = nameFor(lines.map(l => l.text), subjects, tops)
  let name = base, i = 1
  while (taken(name)) name = `${base}${++i}`
  const params = [...free].map(([k, t]) => `${k}: ${t}`).join(', ')
  const props = [...free.keys()].map(k => ` ${k}=${k}`).join('')
  const body = lines.map(l => l.blank ? '' : '  ' + l.text.slice(m)).join('\n')
  const call = ' '.repeat(m) + name + props
  const afterTop = s.doc.line(top.to + 1).to
  const fnText = `\n\nfn ${name}(${params})\n${body}`
  const callFrom = start + m
  const delta = call.length - (end - start)
  const defFrom = afterTop + delta + 2 + 3
  view.dispatch({
    changes: [{ from: start, to: end, insert: call }, { from: afterTop, insert: fnText }],
    selection: EditorSelection.create([EditorSelection.range(callFrom, callFrom + name.length), EditorSelection.range(defFrom, defFrom + name.length)], 0),
    scrollIntoView: true,
    userEvent: 'group',
  })
  const passed = free.size ? `받는 값 ${[...free].map(([k, t]) => `${k}: ${t}`).join(', ')}` : '받는 값 없음'
  const warn = written.length ? ` · ⚠ ${written.join(', ')} 은 안에서 바뀌어서 같이 넘겼어 (바깥 값은 그대로)` : ''
  toast(`${name} 로 묶었어 · ${passed}${warn} · 바로 치면 이름이 두 곳 다 바뀌어`)
  view.dispatch({ effects: EditorView.announce.of(`${l2 - l1 + 1}줄을 ${name} 로 묶음. ${passed}${warn}. 이름을 바로 고칠 수 있어`) })
  return true
}

let openFile: (file: string, line?: number) => void = () => {}
export const setOpenFile = (f: typeof openFile) => { openFile = f }

export function gotoDef(view: EditorView, pos = view.state.selection.main.head): boolean {
  const hit = symAt(view.state, pos)
  if (!hit || hit.sym.from < 0) return false
  if (hit.sym.file) { openFile(hit.sym.file, hit.sym.line); return true }
  view.dispatch({ selection: { anchor: hit.sym.from }, scrollIntoView: true })
  return true
}


// ── 손에 맞는 띄어쓰기 ──
// 선언 자리에서 `이름:` → `이름: ` · `이름 =` → `이름 = ` · 괄호 안 `,` → `, `.
// 자동으로 넣은 칸 바로 뒤에 스페이스를 치면 삼킨다. 태그 속성(onClick=…)은 붙여 쓰는 그대로.
let autoSpaceAt = -1
const DECL_HEAD = /^\s*(?:var\s+|let\s+)?[\p{L}_][\p{L}\p{N}_]*$/u
const DECL_TYPED = /^\s*(?:var\s+|let\s+)?[\p{L}_][\p{L}\p{N}_]*: ?[\p{L}_][\p{L}\p{N}_]*(\[\])?\??$/u
const ASSIGN_HEAD = /^\s*[\p{L}_][\p{L}\p{N}_.\[\]]*\s*[-+*/]?$/u
const smartInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.state.selection.ranges.length > 1 || from !== to) return false
  const line = view.state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from)
  const after = line.text.slice(from - line.from)
  const inStr = (before.match(/"/g)?.length ?? 0) % 2 === 1
  if (inStr) { autoSpaceAt = -1; return false }
  const put = (ins: string, extra = 0) => {
    view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length + extra }, userEvent: 'input.type' })
    autoSpaceAt = from + ins.length
    return true
  }
  if (text === ' ' && from === autoSpaceAt) { autoSpaceAt = -1; return true }
  autoSpaceAt = -1
  if (text === ':' && DECL_HEAD.test(before) && !/^\s*(model|fn|for|if|else|catch|use|mount|serve|route)\b/.test(before) && !after.startsWith(' ')) {
    // 모델 칸이나 선언: name: Type
    return put(': ')
  }
  if (text === '=' && !after.startsWith('=') && !/[=!<>]$/.test(before)) {
    const b = before.replace(/ +$/, '')
    const op = /[-+*/]$/.test(b)
    if ((DECL_TYPED.test(b) || (ASSIGN_HEAD.test(b) && !/\s\S+$/.test(b.trim()))) && !/^\s*(if|for|button|input|a|form|ul|li|p|div)\b/.test(b)) {
      const lead = op ? b.slice(0, -1).replace(/ +$/, '') + ' ' + b.slice(-1) : b + ' '
      view.dispatch({ changes: { from: line.from, to, insert: lead + '= ' }, selection: { anchor: line.from + lead.length + 2 }, userEvent: 'input.type' })
      autoSpaceAt = line.from + lead.length + 2
      return true
    }
  }
  if (text === ',' && (before.match(/\(/g)?.length ?? 0) > (before.match(/\)/g)?.length ?? 0) && !after.startsWith(' ')) return put(', ')
  return false
})

/** 여러 줄 붙여넣기는 지금 줄 들여쓰기에 맞춰 다시 앉힌다 */
const pasteIndent = EditorView.domEventHandlers({
  paste(e, view) {
    const text = e.clipboardData?.getData('text/plain')
    if (!text || !text.includes('\n') || view.state.selection.ranges.length > 1) return false
    const r = view.state.selection.main
    const line = view.state.doc.lineAt(r.from)
    const before = line.text.slice(0, r.from - line.from)
    if (before.trim()) return false
    const ls = text.replace(/\t/g, '  ').split('\n')
    const min = Math.min(...ls.filter(l => l.trim()).map(l => /^ */.exec(l)![0].length))
    const pad = before.length
    const out = ls.map((l, i) => !l.trim() ? '' : (i === 0 ? '' : ' '.repeat(pad)) + l.slice(min)).join('\n')
    e.preventDefault()
    view.dispatch({ changes: { from: r.from, to: r.to, insert: out }, selection: { anchor: r.from + out.length }, scrollIntoView: true, userEvent: 'input.paste' })
    return true
  },
})

/** else 는 짝이 되는 if 에 맞춰 자동으로 내어 쓴다 */
const dedentPair = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ') return false
  const line = view.state.doc.lineAt(from)
  const m = /^( *)else$/.exec(line.text.slice(0, from - line.from))
  if (!m) return false
  const cur = m[1].length
  for (let n = line.number - 1, k = 0; n >= 1 && k < 200; n--, k++) {
    const t = view.state.doc.line(n).text
    if (!t.trim()) continue
    const ind = /^ */.exec(t)![0].length
    const isIf = /^ *if\b/.test(t)
    if (!isIf) { if (ind >= cur) continue; return false }
    if (ind > cur) continue
    if (ind === cur) return false
    view.dispatch({ changes: [{ from: line.from, to: line.from + cur, insert: ' '.repeat(ind) }, { from, to, insert: ' ' }], selection: { anchor: from - cur + ind + 1 }, userEvent: 'input.type' })
    return true
  }
  return false
})

/** ⌘Enter: 줄을 자르지 않고 아래에 새 줄 · ⌘⇧Enter: 위에 */
function lineBelow(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const ind = /^ */.exec(line.text)![0].length + (opens(line.text) ? 2 : 0)
  const ins = '\n' + ' '.repeat(ind)
  view.dispatch({ changes: { from: line.to, insert: ins }, selection: { anchor: line.to + ins.length }, scrollIntoView: true, userEvent: 'input' })
  return true
}
function lineAbove(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const ind = /^ */.exec(line.text)![0].length
  const ins = ' '.repeat(ind) + '\n'
  view.dispatch({ changes: { from: line.from, insert: ins }, selection: { anchor: line.from + ind }, scrollIntoView: true, userEvent: 'input' })
  return true
}

export const edit = [
  Prec.high(keymap.of([
    { key: 'Enter', run: enter },
    { key: 'Backspace', run: backspace },
    { key: 'Mod-g', run: group, preventDefault: true },
    { key: 'F12', run: v => gotoDef(v) },
    { key: 'Mod-Enter', run: lineBelow, preventDefault: true },
    { key: 'Mod-Shift-Enter', run: lineAbove, preventDefault: true },
  ])),
  smartInput,
  dedentPair,
  pasteIndent,
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos === null) return false
      e.preventDefault()
      return gotoDef(view, pos)
    },
  }),
]
void STD


// ── 뻔한 건 알아서 ──
// 줄을 떠날 때 그 줄에 '뻔한 고침'(auto) 이 있으면 바로 적용한다. 예: up = name.upper() → up: Text = name.upper()
// 되돌리기로 돌아온 경우엔 손대지 않는다 (사람이 원래 모양을 원한 것).
export const autoFix = ViewPlugin.fromClass(class {
  line = -1
  skip = false
  update(u: ViewUpdate) {
    if (u.transactions.some(t => t.isUserEvent('undo') || t.isUserEvent('redo'))) { this.skip = true }
    const now = u.state.doc.lineAt(u.state.selection.main.head).number
    if (this.line < 0) { this.line = now; return }
    if (now === this.line) return
    const left = this.line
    this.line = now
    if (this.skip) { this.skip = false; return }
    if (left > u.state.doc.lines) return
    const L = u.state.doc.line(left)
    const a = u.state.field(live, false)?.a
    const h = a?.holes.find(h => h.auto && h.fix && h.from >= L.from && h.from <= L.to)
    if (!h?.fix) return
    const f = h.fix
    const view = u.view
    queueMicrotask(() => {
      if (view.state.sliceDoc(L.from, L.to) !== u.state.sliceDoc(L.from, L.to)) return
      view.dispatch({ changes: { from: f.at, to: f.to, insert: f.insert }, userEvent: 'input.auto' })
    })
  }
})
