// ⌘K: 코드가 뒤로 눕고, 블록들이 앞으로 떠올라 깊이로 쌓인다.
import type { EditorView } from '@codemirror/view'
import { live } from './live'
import { jump } from './preview'
import { fmt } from '../core/run'

const KIND: Record<string, string> = { model: '모델', decl: '상태', fn: '하는 일', comp: '화면 조각', mount: '화면', serve: '서버', use: '가져오기', call: '사건', expr: '식' }

interface Card { label: string; kind: string; name: string; code: string; info: string; line?: number; file?: string }

export function openOverview(view: EditorView, files: { name: string; open: () => void }[], current: string) {
  if (document.querySelector('.over')) return
  const { a, w } = view.state.field(live)
  const ed = document.getElementById('editor')!
  const cards: Card[] = []
  for (const b of a.blocks) {
    const n = b.node
    let kind = n.kind === 'fn' ? (/^[A-Z]/.test(b.name) ? 'comp' : 'fn') : n.kind === 'call' ? (b.name === 'mount' || b.name === 'serve' ? b.name : 'call') : n.kind
    let info = ''
    if (n.kind === 'decl') { const p = w.peek(b.name); info = p.ok ? fmt(p.v, 1) : p.why; if (a.writable.has(b.name)) kind = 'decl' }
    if (n.kind === 'model') info = n.children.filter(c => c.kind === 'field').map(c => c.name).join(' · ')
    if (n.kind === 'fn') info = (n.params ?? []).map(p => p.name).join(', ')
    if (n.kind === 'use') info = n.use?.path ?? ''
    const code = a.tree.lines.slice(b.from, Math.min(b.to + 1, b.from + 4)).map(l => l.text).join('\n')
    cards.push({ label: KIND[kind] ?? kind, kind, name: b.name, code, info, line: b.from })
  }
  for (const f of files) if (f.name !== current) cards.push({ label: '파일', kind: 'file', name: f.name, code: '', info: '이 파일로 가기', file: f.name })

  const over = document.createElement('div')
  over.className = 'over'
  const input = document.createElement('input')
  input.className = 'over-q'
  input.placeholder = '이름이나 종류로 찾기 · ↑↓ · ↵'
  input.spellcheck = false
  const stage = document.createElement('div')
  stage.className = 'over-stage'
  over.append(input, stage)
  document.body.append(over)
  ed.classList.add('away')
  requestAnimationFrame(() => over.classList.add('in'))

  const cur = a.blocks.findIndex(b => view.state.doc.lineAt(view.state.selection.main.head).number - 1 <= b.to)
  let sel = Math.max(0, cur)
  let shown = cards

  const els = cards.map((c, i) => {
    const d = document.createElement('div')
    d.className = `over-card k-${c.kind}`
    d.innerHTML = `<div class="oc-top"><i></i><b></b></div><pre></pre><span></span>`
    d.querySelector('i')!.textContent = c.label
    d.querySelector('b')!.textContent = c.name
    d.querySelector('pre')!.textContent = c.code
    d.querySelector('span')!.textContent = c.info
    d.onclick = () => { if (shown[sel] === c) go(); else { sel = shown.indexOf(c); place() } }
    void i
    stage.append(d)
    return d
  })

  const place = () => {
    cards.forEach((c, i) => {
      const e = els[i]
      const j = shown.indexOf(c)
      if (j < 0) { e.style.opacity = '0'; e.style.pointerEvents = 'none'; e.style.transform = 'translate3d(0, 300px, 200px)'; return }
      const o = j - sel
      e.classList.toggle('sel', o === 0)
      e.style.pointerEvents = o < 0 || o > 6 ? 'none' : ''
      if (o < 0) { e.style.transform = `translate3d(0, ${140 + -o * 20}px, ${200 - o * 40}px) rotateX(-8deg)`; e.style.opacity = '0' }
      else {
        e.style.transform = `translate3d(0, ${-o * 54}px, ${-o * 130}px)`
        e.style.opacity = o > 6 ? '0' : '1'
        e.style.filter = o ? `brightness(${Math.max(0.35, 1 - o * 0.13)})` : ''
      }
      e.style.zIndex = String(100 - Math.abs(o))
    })
  }
  place()
  input.focus()

  const close = () => {
    over.classList.remove('in'); over.classList.add('out')
    ed.classList.remove('away')
    setTimeout(() => over.remove(), 380)
    removeEventListener('keydown', key, true)
  }
  const go = () => {
    const c = shown[sel]
    close()
    if (!c) return view.focus()
    if (c.file) return files.find(f => f.name === c.file)?.open()
    setTimeout(() => jump(view, c.line!), 120)
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); view.focus() }
    else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); place() }
    else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); sel = Math.max(0, sel - 1); place() }
    else if (e.key === 'Enter') { e.preventDefault(); go() }
  }
  addEventListener('keydown', key, true)
  input.oninput = () => {
    const q = input.value.trim().toLowerCase()
    shown = q ? cards.filter(c => (c.name + ' ' + c.label + ' ' + c.info).toLowerCase().includes(q)) : cards
    sel = 0
    place()
  }
  over.addEventListener('wheel', e => { e.preventDefault(); sel = Math.max(0, Math.min(shown.length - 1, sel + (e.deltaY > 0 ? 1 : -1))); place() }, { passive: false })
  over.addEventListener('mousedown', e => { if (e.target === over || e.target === stage) { close(); view.focus() } })
}
