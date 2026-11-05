// 갔다가 돌아오기. 정의로 뛰거나 ⌘K 로 가거나 멀리 클릭하면 자리를 기억한다.
// ⌘[ 돌아가기 · ⌘] 다시 가기 · 마우스 뒤로/앞으로 버튼도.
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { Annotation, type EditorState } from '@codemirror/state'
import { nodeAt, label } from './nest'
import { live } from './live'
import { keyLabel } from './keys'

interface Spot { file: string; pos: number; line: number; what: string }
const backs: Spot[] = []
const fwds: Spot[] = []
/** 이 트랜잭션은 자리 기억에서 뺀다 (미리 보기 등) */
export const navigating = Annotation.define<boolean>()
let fileNow = () => ''
let openAt: (file: string, pos: number) => void = () => {}
export function setNav(o: { file: () => string; openAt: (file: string, pos: number) => void }) { fileNow = o.file; openAt = o.openAt }

const FAR = 12

function spotOf(state: EditorState, pos: number): Spot {
  const line = state.doc.lineAt(pos)
  let what = ''
  try { const n = nodeAt(state.field(live).a, line.number - 1); if (n) what = label(n) } catch { /* 분석 전 */ }
  return { file: fileNow(), pos, line: line.number, what }
}

function push(s: Spot) {
  const last = backs[backs.length - 1]
  if (last && last.file === s.file && Math.abs(last.line - s.line) < 3) return
  backs.push(s)
  if (backs.length > 60) backs.shift()
  fwds.length = 0
  paint()
}

/** 지정한 자리를 기억 */
export function rememberAt(state: EditorState, pos: number) { push(spotOf(state, pos)) }

/** 다른 파일로 가기 전에 부른다 */
export function rememberHere(view: EditorView) { push(spotOf(view.state, view.state.selection.main.head)) }

function go(view: EditorView, from: Spot[], to: Spot[]): boolean {
  const s = from.pop()
  if (!s) { paint(); return false }
  to.push(spotOf(view.state, view.state.selection.main.head))
  if (s.file !== fileNow()) openAt(s.file, s.pos)
  else {
    const pos = Math.min(s.pos, view.state.doc.length)
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), annotations: navigating.of(true) })
  }
  view.dispatch({ effects: EditorView.announce.of(`${s.what || `${s.line}줄`} 로 돌아옴`) })
  paint()
  view.focus()
  return true
}
export const navBack = (view: EditorView) => go(view, backs, fwds)
export const navForward = (view: EditorView) => go(view, fwds, backs)
export const canBack = () => backs.length > 0

// ── 왼쪽 위 돌아가기 칩 ──
let chip: HTMLButtonElement | undefined
let viewRef: EditorView | undefined
let mouseHooked = false
function paint() {
  if (!chip) return
  const s = backs[backs.length - 1]
  chip.classList.toggle('on', !!s)
  chip.tabIndex = s ? 0 : -1
  chip.setAttribute('aria-hidden', String(!s))
  if (!s) return
  const where = `${s.file !== fileNow() ? `${s.file.split('/').pop()} · ` : ''}${s.what || `${s.line}줄`}`
  chip.innerHTML = `<span class="nb-arrow">←</span><span class="nb-what"></span><kbd>${keyLabel('Mod-[')}</kbd>`
  chip.querySelector('.nb-what')!.textContent = where
  chip.setAttribute('aria-label', `돌아가기: ${where}`)
}

export const nav = [
  ViewPlugin.fromClass(class {
    constructor(view: EditorView) {
      viewRef = view
      chip = document.querySelector('.navback') as HTMLButtonElement ?? undefined
      if (!chip) {
        chip = document.createElement('button')
        chip.className = 'navback'
        document.getElementById('editor')!.append(chip)
      }
      chip.onmousedown = e => { e.preventDefault(); if (viewRef) navBack(viewRef) }
      paint()
      if (!mouseHooked) {
        mouseHooked = true
        // 마우스 뒤로/앞으로 버튼: 브라우저 뒤로가기 대신 코드 안에서
        const stop = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault() }
        window.addEventListener('mousedown', stop, true)
        window.addEventListener('mouseup', e => {
          if (e.button !== 3 && e.button !== 4) return
          e.preventDefault()
          if (viewRef) e.button === 3 ? navBack(viewRef) : navForward(viewRef)
        }, true)
      }
    }
    update(u: ViewUpdate) {
      viewRef = u.view
      if (!u.selectionSet || u.docChanged) return
      if (u.transactions.some(t => t.annotation(navigating))) return
      const a = u.startState.doc.lineAt(u.startState.selection.main.head).number
      const b = u.state.doc.lineAt(u.state.selection.main.head).number
      if (Math.abs(a - b) >= FAR) push(spotOf(u.startState, u.startState.selection.main.head))
    }
  }),
]
