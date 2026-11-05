// 단축키: 하나의 목록이 키맵 · 아래 힌트 줄 · 전체 단축키 · ⌘K 를 모두 만든다.
import { EditorView, keymap } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

export interface Cmd {
  id: string
  label: string
  group: '기본' | '이동' | '겹' | '고치기' | '만들기' | '보기' | '파일'
  key?: string            // CodeMirror 키 이름 (Mod-k)
  shown?: string          // 키 대신 보여줄 말 (⌘클릭)
  run: (v: EditorView) => boolean
  when?: (s: EditorState) => boolean   // 힌트 줄에 뜰 때
  hint?: number           // 힌트 줄 우선순위 (클수록 앞)
  palette?: boolean       // ⌘K 에서 숨기려면 false
  sheet?: boolean         // 단축키 목록에서 숨기려면 false
}

// CodeMirror 의 Mod 판정과 똑같이 맞춘다 (표시와 실제 키가 어긋나지 않게)
export const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
const SYM: Record<string, string> = MAC
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Tab: '⇥' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', Tab: 'Tab' }

export function keyLabel(key: string): string {
  const parts = key.endsWith('--') ? [...key.slice(0, -2).split('-'), '-'] : key.split('-')
  const out = parts.map(p => SYM[p] ?? (p.length === 1 ? p.toUpperCase() : p))
  return MAC ? out.join('') : out.join('+')
}
export function kbd(c: Cmd): string {
  const k = c.shown ?? (c.key ? keyLabel(c.key) : '')
  return k ? `<kbd>${k}</kbd>` : ''
}
/** 화면에 적힌 ⌘ 표기를 이 기기에 맞게 */
export const localize = (t: string) => MAC ? t : t.replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+')

export function keysOf(cmds: Cmd[]) {
  return keymap.of(cmds.filter(c => c.key).map(c => ({ key: c.key!, run: c.run, preventDefault: true })))
}

// ── 브라우저 기본 동작 막기 ──
// 에디터가 처리하지 않은 조합키는 버블 단계에서 막는다 (캡처에서 막으면 CodeMirror 도 무시한다).
const PASS = new Set(['c', 'v', 'x'])   // 복사 · 붙여넣기 · 잘라내기는 clipboard 이벤트가 필요
export function guardBrowser() {
  window.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const t = e.target as HTMLElement
    const field = t?.closest?.('input, textarea')
    if (mod && !e.altKey && PASS.has(k)) return
    if (field) { if (mod && !['a', 'z', 'y'].includes(k)) e.preventDefault(); return }
    if (mod || e.altKey || /^F\d+$/.test(e.key) || e.key === 'Tab') { e.preventDefault(); return }
    if (!t?.closest?.('.cm-content') && [' ', 'Backspace', '/', "'", 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault()
  })
  const stop = (e: Event) => e.preventDefault()
  window.addEventListener('contextmenu', stop)
  window.addEventListener('dragover', stop)
  window.addEventListener('drop', e => { if (!(e.target as HTMLElement)?.closest?.('.cm-content')) e.preventDefault() })
  window.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
  window.addEventListener('auxclick', stop)
  window.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault() })
  for (const g of ['gesturestart', 'gesturechange']) window.addEventListener(g, stop as EventListener)
  document.addEventListener('selectstart', e => { if (!(e.target as HTMLElement)?.closest?.('.cm-content, input, textarea, .pv-screen')) e.preventDefault() })
}

// ── 아래 힌트 줄 + 펼치면 전체 단축키 ──
export function keyStrip(host: HTMLElement, view: () => EditorView, cmds: Cmd[]) {
  host.innerHTML = '<div class="ks-now"></div><button class="ks-all" title="단축키 전부"></button><div class="ks-sheet" role="dialog" aria-label="단축키"></div>'
  const now = host.querySelector('.ks-now') as HTMLElement
  const all = host.querySelector('.ks-all') as HTMLButtonElement
  const sheet = host.querySelector('.ks-sheet') as HTMLElement
  const toggle = cmds.find(c => c.id === 'keys')
  all.innerHTML = `단축키 ${toggle ? kbd(toggle) : ''}`
  all.onmousedown = e => { e.preventDefault(); setOpen(!host.classList.contains('open')) }
  const groups = new Map<string, Cmd[]>()
  for (const c of cmds) if ((c.key || c.shown) && c.sheet !== false) (groups.get(c.group) ?? groups.set(c.group, []).get(c.group)!).push(c)
  const k = (id: string) => { const c = cmds.find(x => x.id === id); return c ? kbd(c) : '' }
  sheet.innerHTML = `<header><b>단축키</b><span>외울 건 ${k('cmdk')} 찾기 · ${k('here')} 여기서 · <kbd>Esc</kbd> 셋. 나머진 ${k('cmdk')} 에 이름으로 쳐도 돼</span></header><div class="ks-cols">` + [...groups].map(([g, cs]) => `<section><h4>${g}</h4>${cs.map(c => `<div class="ks-row" data-id="${c.id}"><span>${c.label}</span>${kbd(c)}</div>`).join('')}</section>`).join('') + '</div>'
  sheet.onmousedown = e => {
    e.preventDefault()
    const row = (e.target as HTMLElement).closest('.ks-row') as HTMLElement | null
    const c = row && cmds.find(x => x.id === row.dataset.id)
    if (c) { setOpen(false); c.run(view()); view().focus() }
  }
  let sig = ''
  const refresh = (s: EditorState) => {
    const on = cmds.filter(c => c.hint && (!c.when || c.when(s))).sort((a, b) => b.hint! - a.hint!).slice(0, 4)
    const next = on.map(c => c.id).join()
    if (next === sig) return
    sig = next
    now.innerHTML = on.map(c => `<span class="ks-hint" data-id="${c.id}">${kbd(c)}${c.label}</span>`).join('')
    for (const el of now.querySelectorAll<HTMLElement>('.ks-hint')) {
      el.onmousedown = e => { e.preventDefault(); cmds.find(x => x.id === el.dataset.id)?.run(view()); view().focus() }
    }
  }
  function setOpen(o: boolean) { host.classList.toggle('open', o) }
  return {
    refresh,
    toggle: () => { setOpen(!host.classList.contains('open')); return true },
    close: () => { if (!host.classList.contains('open')) return false; setOpen(false); return true },
  }
}
