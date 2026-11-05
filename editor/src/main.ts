import { EditorView, keymap, drawSelection, lineNumbers, highlightSpecialChars } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap, indentMore, indentLess, undo, redo } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { live, setResolver, setFile, resetWorld } from './ed/live'
import { focusBlock, slabs, previewDeco, watchWorld } from './ed/block'
import { hoverField, jump } from './ed/preview'
import { paint } from './ed/paint'
import { lens, symAt } from './ed/lens'
import { deck } from './ed/deck'
import { edit, setOpenFile, group, gotoDef, setEditToast, autoFix } from './ed/edit'
import { hover, peekHere } from './ed/hover'
import { nav, navBack, navForward, setNav, rememberHere, canBack } from './ed/nav'
import { nest, nestCommands, nestField, nodeAt, label } from './ed/nest'
import { trace, traceLines, traceColumn } from './ed/trace'
import { refactor, renameAll, bulkNext, escapeLink, linkField, bulkField, onRenamed, setUsersOf } from './ed/refactor'
import { guardBrowser, keysOf, keyStrip, localize, keyLabel, MAC, type Cmd } from './ed/keys'
import { openCommand, type Elsewhere } from './ed/command'
import { analyze, type Resolve } from './core/analyze'
import './style.css'

let whereT = 0, whereNow = ''

const raw = import.meta.glob('../../examples/**/*.mrc', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ORIGINAL: Record<string, string> = {}
for (const [p, t] of Object.entries(raw)) ORIGINAL[p.replace(/^.*examples\//, '').replace(/\.mrc$/, '')] = t
const ORDER = ['cart', 'users/client', 'users/server', 'users/user', 'chat', 'sync']
const NAMES = [...ORDER.filter(n => n in ORIGINAL), ...Object.keys(ORIGINAL).filter(n => !ORDER.includes(n)).sort()]
const KEY = (n: string) => `miracle3:${n}`
const textOf = (n: string) => n === current && view ? view.state.doc.toString() : localStorage.getItem(KEY(n)) ?? ORIGINAL[n] ?? ''

const resolve: Resolve = (from, path) => {
  const dir = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const parts = (dir ? dir.split('/') : [])
  for (const seg of path.split('/')) { if (seg === '.' || !seg) continue; if (seg === '..') parts.pop(); else parts.push(seg) }
  const name = parts.join('/')
  if (!(name in ORIGINAL)) return undefined
  return { file: name, text: textOf(name) }
}
setResolver(resolve)

let current = new URLSearchParams(location.search).get('f') ?? localStorage.getItem('miracle3:last') ?? 'cart'
if (!(current in ORIGINAL)) current = NAMES[0]

// ── 다른 파일 읽기 (열려 있는 동안만 기억) ──
const otherCache = new Map<string, ReturnType<typeof analyze>>()
const otherOf = (n: string) => otherCache.get(n) ?? otherCache.set(n, analyze(textOf(n), resolve, n)).get(n)!
const refsTo = (n: string, file: string, name: string) => otherOf(n).refs.filter(r => r.sym.file === file && r.sym.name === name)

setUsersOf((file, name) => NAMES.filter(n => n !== file && refsTo(n, file, name).length).map(n => n.split('/').pop()!))
onRenamed(({ file, from, to }) => {
  const touched: string[] = []
  for (const n of NAMES) {
    if (n === file) continue
    const refs = refsTo(n, file, from)
    if (!refs.length) continue
    let t = textOf(n)
    for (const r of [...refs].sort((x, y) => y.from - x.from)) t = t.slice(0, r.from) + to + t.slice(r.to)
    localStorage.setItem(KEY(n), t)
    otherCache.delete(n)
    touched.push(`${n.split('/').pop()} ${refs.length}곳`)
  }
  if (touched.length) { toast(`${from} → ${to} · ${touched.join(', ')}도 바꿨어`); files() }
})
const elsewhere = (): Elsewhere[] => NAMES.filter(n => n !== current).flatMap(n => otherOf(n).blocks.map(b => ({ file: n, name: b.name, kind: b.kind, line: b.from })))

// ── 명령: 키맵 · 힌트 줄 · 단축키 · ⌘K 가 모두 여기서 나온다 ──
const onSym = (s: EditorState) => { const h = symAt(s, s.selection.main.head); return !!h && h.sym.kind !== 'std' && h.sym.kind !== 'builtin' }
const lineEmpty = (s: EditorState) => s.doc.lineAt(s.selection.main.head).text.trim() === ''
const onBody = (s: EditorState) => { const n = s.field(live).a.tree.byLine[s.doc.lineAt(s.selection.main.head).number - 1]; return !!n && n.children.length > 0 }
let density = Number(localStorage.getItem('miracle3:density') ?? '1')
const setDensity = (d: number) => { density = Math.min(1.3, Math.max(0.8, Math.round(d * 10) / 10)); document.documentElement.style.setProperty('--s', String(density)); localStorage.setItem('miracle3:density', String(density)); view.requestMeasure(); toast(`간격 ${Math.round(density * 100)}%`); return true }
let armed = 0

const CMDS: Cmd[] = [
  { id: 'here', group: '기본', label: '여기서 할 수 있는 것 · 고치기', key: 'Mod-.', hint: 12, when: s => s.field(live).a.holes.some(h => s.doc.lineAt(Math.min(h.from, s.doc.length)).number === s.doc.lineAt(s.selection.main.head).number), run: v => { openCommand(v, { cmds: CMDS, files: NAMES, current, open, elsewhere, here: true }); return true } },
  { id: 'cmdk', group: '기본', label: '뭐든 찾기 · 가기', key: 'Mod-k', hint: 1, run: v => { openCommand(v, { cmds: CMDS, files: NAMES, current, open, elsewhere }); return true } },
  { id: 'def', group: '이동', label: '정의로', key: 'F12', shown: `F12 · ${MAC ? '⌘' : 'Ctrl+'}클릭`, hint: 6, when: onSym, run: v => gotoDef(v) },
  { id: 'back', group: '이동', label: '돌아가기', key: 'Mod-[', hint: 11, when: () => canBack(), run: navBack },
  { id: 'forward', group: '이동', label: '다시 가기', key: 'Mod-]', sheet: false, run: navForward },
  { id: 'peek', group: '이동', label: '이게 뭐야', key: 'Mod-i', hint: 6.5, when: onSym, run: peekHere },
  { id: 'prev', group: '이동', label: '앞 블록', key: 'Mod-Alt-ArrowUp', sheet: false, run: nestCommands.prevSibling },
  { id: 'next', group: '이동', label: '뒤 블록', key: 'Mod-Alt-ArrowDown', sheet: false, run: nestCommands.nextSibling },
  { id: 'nextFile', group: '파일', label: '다음 파일', key: 'Mod-Alt-ArrowRight', sheet: false, run: () => { open(NAMES[(NAMES.indexOf(current) + 1) % NAMES.length]); return true } },
  { id: 'prevFile', group: '파일', label: '앞 파일', key: 'Mod-Alt-ArrowLeft', sheet: false, run: () => { open(NAMES[(NAMES.indexOf(current) - 1 + NAMES.length) % NAMES.length]); return true } },

  { id: 'grow', group: '겹', label: '겹 넓히기', key: 'Mod-Shift-ArrowUp', hint: 3, when: s => s.field(nestField).chain.length > 1, run: nestCommands.expand },
  { id: 'shrink', group: '겹', label: '겹 좁히기', key: 'Mod-Shift-ArrowDown', sheet: false, run: nestCommands.shrink },
  { id: 'move', group: '겹', label: '블록째 옮기기', key: 'Alt-ArrowUp', shown: `${keyLabel('Alt-ArrowUp')} ${keyLabel('Alt-ArrowDown')}`, hint: 4, when: onBody, run: nestCommands.moveBlockUp },
  { id: 'moveDown', group: '겹', label: '블록째 아래로', key: 'Alt-ArrowDown', palette: false, sheet: false, run: nestCommands.moveBlockDown },
  { id: 'fold', group: '겹', label: '접기', key: 'Mod-Alt-[', hint: 2, when: s => !!s.field(nestField).inner, run: nestCommands.foldHere },
  { id: 'unfold', group: '겹', label: '펼치기', key: 'Mod-Alt-]', sheet: false, run: nestCommands.unfoldHere },
  { id: 'foldAll', group: '겹', label: '전부 접기', key: 'Mod-Alt-0', sheet: false, run: nestCommands.foldAll },
  { id: 'unfoldAll', group: '겹', label: '전부 펼치기', key: 'Mod-Alt-9', sheet: false, run: nestCommands.unfoldAll },

  { id: 'escLink', group: '고치기', label: '여기만 바꾸기', key: 'Escape', hint: 10, palette: false, when: s => !!s.field(linkField), run: escapeLink },
  { id: 'rename', group: '고치기', label: '이름 바꾸기', key: 'F2', hint: 9, when: onSym, run: renameAll },
  { id: 'bulk', group: '고치기', label: '같은 것 고르기', key: 'Mod-d', hint: 8, when: s => onSym(s) || !!s.field(bulkField), run: bulkNext },
  { id: 'group', group: '고치기', label: '컴포넌트로 묶기', key: 'Mod-g', hint: 7, when: s => !s.selection.main.empty || (onBody(s) && s.field(live).a.blocks.some(b => b.node.kind === 'fn' && b.from < s.doc.lineAt(s.selection.main.head).number - 1 && b.to >= s.doc.lineAt(s.selection.main.head).number - 1)), run: group },
  { id: 'below', group: '고치기', label: '아래에 새 줄', key: 'Mod-Enter', palette: false, sheet: false, run: () => false },
  { id: 'above', group: '고치기', label: '위에 새 줄', key: 'Mod-Shift-Enter', palette: false, sheet: false, run: () => false },
  { id: 'indent', group: '고치기', label: '들여쓰기', key: 'Tab', shown: `${keyLabel('Tab')} · ${keyLabel('Shift-Tab')}`, palette: false, run: indentMore },
  { id: 'outdent', group: '고치기', label: '내어쓰기', key: 'Shift-Tab', palette: false, sheet: false, run: indentLess },
  { id: 'undo', group: '고치기', label: '되돌리기', key: 'Mod-z', sheet: false, run: undo },
  { id: 'redo', group: '고치기', label: '다시 하기', key: 'Mod-Shift-z', sheet: false, run: redo },

  { id: 'new', group: '만들기', label: '새로 만들기', shown: '/', hint: 5, when: lineEmpty, run: v => { v.dispatch(v.state.replaceSelection('/'), { userEvent: 'input.type' }); return true } },

  { id: 'dim', group: '보기', label: '초점 모드', run: nestCommands.toggleDim },
  { id: 'roomy', group: '보기', label: '넓게', key: 'Mod-Alt-=', sheet: false, run: () => setDensity(density + 0.1) },
  { id: 'tight', group: '보기', label: '촘촘하게', key: 'Mod-Alt--', sheet: false, run: () => setDensity(density - 0.1) },
  { id: 'keys', group: '기본', label: '단축키 보기', key: 'Mod-/', run: () => strip.toggle() },
  { id: 'reset', group: '보기', label: '미리보기 값 처음으로', key: 'Mod-Alt-r', sheet: false, run: v => { v.dispatch({ effects: resetWorld.of(null) }); toast('값을 처음으로 돌렸어'); return true } },
  { id: 'restore', group: '파일', label: '이 파일 예제 원본으로', run: () => {
    if (Date.now() - armed > 2500) { armed = Date.now(); toast('한 번 더 하면 원본으로 돌아가'); return true }
    localStorage.removeItem(KEY(current)); armed = 0; open(current); toast('원본으로 돌렸어'); return true
  } },
]

const strip = keyStrip(document.getElementById('keys')!, () => view, CMDS)

function extensions() {
  return [
    lineNumbers(),
    traceColumn,
    highlightSpecialChars(),
    history(),
    drawSelection({ cursorBlinkRate: 0 }),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    closeBrackets(),
    live,
    focusBlock,
    nest,
    slabs,
    previewDeco,
    hoverField,
    paint,
    traceLines,
    trace,
    refactor,
    lens,
    hover,
    nav,
    deck,
    edit,
    autoFix,
    Prec.high(keymap.of([{ key: 'Escape', run: () => strip.close() }])),
    keysOf(CMDS),
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...defaultKeymap]),
    // 화면 읽기: 다른 겹으로 들어가면 경로를 한 번 읽어 준다
    EditorView.updateListener.of(u => {
      if (!u.selectionSet && !u.docChanged) return
      clearTimeout(whereT)
      whereT = window.setTimeout(() => {
        try {
          const st = u.view.state, ln = st.doc.lineAt(st.selection.main.head).number - 1
          let n = nodeAt(st.field(live).a, ln); const path: string[] = []
          while (n) { path.unshift(label(n)); n = n.parent }
          const now = path.join(' › ')
          if (now && now !== whereNow) { whereNow = now; u.view.dispatch({ effects: EditorView.announce.of(`${ln + 1}줄 · ${now}`) }) }
        } catch { /* 분석 전 */ }
      }, 450)
    }),
    EditorView.contentAttributes.of({ 'aria-label': '미라클 코드', 'aria-roledescription': '코드 편집기', 'aria-keyshortcuts': 'Control+K Control+I Control+G F12 F2 Control+[', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.theme({}, { dark: true }),
    EditorView.updateListener.of(u => {
      if (u.docChanged) { clearTimeout(saveT); saveT = window.setTimeout(() => { localStorage.setItem(KEY(current), u.state.doc.toString()); files() }, 300) }
      if (u.docChanged || u.selectionSet || u.transactions.length) { status(); strip.refresh(u.state) }
      if (u.geometryChanged || u.docChanged) u.view.requestMeasure({ key: 'gw', read: v => (v.dom.querySelector('.cm-gutters') as HTMLElement | null)?.offsetWidth ?? 80, write: w => document.documentElement.style.setProperty('--gw', `${w}px`) })
    }),
  ]
}
let saveT = 0

setFile(current)
let view: EditorView = undefined as unknown as EditorView
view = new EditorView({ parent: document.getElementById('editor')! })

function open(name: string, line?: number, pos?: number) {
  if (view.state.doc.length && current !== name) rememberHere(view)
  if (view.state.doc.length || current !== name) localStorage.setItem(KEY(current), view.state.doc.toString())
  current = name
  otherCache.clear()
  localStorage.setItem('miracle3:last', name)
  setFile(name)
  view.setState(EditorState.create({ doc: localStorage.getItem(KEY(name)) ?? ORIGINAL[name] ?? '', extensions: [...extensions(), watchWorld(view)] }))
  view.dispatch({})
  window.history.replaceState(null, '', `?f=${encodeURIComponent(name)}`)
  files()
  status()
  strip.refresh(view.state)
  if (pos !== undefined) { const p = Math.min(pos, view.state.doc.length); view.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: 'center' }) }) }
  else if (line !== undefined) setTimeout(() => jump(view, line), 30)
  view.focus()
}
setOpenFile(open)
setNav({ file: () => current, openAt: (f, p) => open(f, undefined, p) })
setEditToast(m => toast(m))

// ── 위 막대 ──
function files() {
  const el = document.getElementById('files')!
  el.textContent = ''
  for (const n of NAMES) {
    const b = document.createElement('button')
    const [dir, base] = n.includes('/') ? [n.slice(0, n.lastIndexOf('/') + 1), n.slice(n.lastIndexOf('/') + 1)] : ['', n]
    b.innerHTML = dir ? `<i>${dir}</i>${base}` : base
    b.dataset.name = n
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(n === current))
    if (n === current) b.className = 'on'
    const saved = n === current ? view.state.doc.toString() : localStorage.getItem(KEY(n))
    if (saved !== null && saved !== ORIGINAL[n]) b.classList.add('edited')
    b.tabIndex = n === current ? 0 : -1
    b.onmousedown = e => { e.preventDefault(); if (n !== current) open(n) }
    b.onkeydown = e => {
      const i = NAMES.indexOf(n)
      const go = e.key === 'ArrowRight' ? NAMES[(i + 1) % NAMES.length] : e.key === 'ArrowLeft' ? NAMES[(i - 1 + NAMES.length) % NAMES.length] : e.key === 'Enter' || e.key === ' ' ? n : null
      if (!go) return
      e.preventDefault()
      if (go !== current) open(go)
      ;(document.querySelector(`#files [data-name="${go}"]`) as HTMLElement | null)?.focus()
    }
    el.append(b)
  }
}
function status() {
  const { a, w } = view.state.field(live)
  const exp = [...w.expectations().values()]
  const ok = exp.filter(e => e.ok).length
  const el = document.getElementById('status')!
  const holes = a.holes.length
  const html = `<span class="st ${holes ? 'warn' : 'good'}"><i></i>${holes ? `빈칸 ${holes}` : '빈칸 없음'}</span>` + (exp.length ? `<span class="st ${ok === exp.length ? 'good' : 'warn'}"><i></i>기대 ${ok}/${exp.length}</span>` : '')
  if (el.innerHTML !== html) el.innerHTML = html
}
let toastT = 0
function toast(msg: string) {
  const el = document.getElementById('toast')!
  el.textContent = msg
  el.classList.add('on')
  clearTimeout(toastT)
  toastT = window.setTimeout(() => el.classList.remove('on'), Math.max(2400, msg.length * 70))
}
document.getElementById('find')!.onmousedown = e => { e.preventDefault(); CMDS[0].run(view) }
document.getElementById('find')!.innerHTML = `찾기 · 할 일 <kbd>${localize('⌘K')}</kbd>`

guardBrowser()
document.documentElement.style.setProperty('--s', String(density))
open(current)
;(window as any).miracle = view
