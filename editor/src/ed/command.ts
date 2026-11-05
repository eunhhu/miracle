// ⌘K: 하고 싶은 걸 치면 된다. 블록 · 파일 · 이름 · 명령이 한 줄에서 찾아지고,
// 고르는 동안 에디터가 그 자리를 미리 보여준다 (Esc 면 원래 자리로).
import { EditorView } from '@codemirror/view'
import { live } from './live'
import { describe, KIND_WORD } from './lens'
import { kbd, type Cmd } from './keys'
import { symAt } from './lens'
import { occurrences } from './trace'
import { navigating, rememberAt } from './nav'
import { nodeAt, label } from './nest'

export interface Elsewhere { file: string; name: string; kind: string; line: number }
interface Item { kind: 'cmd' | 'block' | 'file' | 'sym' | 'site' | 'line'; title: string; sub: string; right: string; tone: string; run: () => void; peek?: () => void; key: string; at?: number }

function score(q: string, s: string): number {
  if (!q) return 1
  const t = s.toLowerCase()
  const i = t.indexOf(q)
  if (i >= 0) return 100 - i - (t.length - q.length) * 0.1 + (i === 0 ? 20 : 0)
  let j = 0, run = 0, sc = 0
  for (const ch of t) { if (ch === q[j]) { j++; run++; sc += run } else run = 0; if (j === q.length) break }
  return j === q.length ? sc : -1
}

export function openCommand(view: EditorView, o: { cmds: Cmd[]; files: string[]; current: string; open: (f: string, line?: number) => void; elsewhere: () => Elsewhere[]; here?: boolean }) {
  if (document.querySelector('.cmdk')) return
  const host = view.dom.parentElement!
  const home = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, top: view.scrollDOM.scrollTop }
  const el = document.createElement('div')
  el.className = 'cmdk'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', '찾기')
  el.innerHTML = `<div class="cmdk-in"><span class="cmdk-icon" aria-hidden="true">⌘</span><input role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" placeholder="${o.here ? '여기서 할 수 있는 것' : '블록 · 파일 · 이름 · 할 일   :줄   >명령'}" aria-label="${o.here ? '여기서 할 수 있는 것' : '블록, 파일, 이름, 할 일 찾기'}" spellcheck="false" autocomplete="off"/><span class="cmdk-esc"><kbd>Esc</kbd></span></div><div class="cmdk-list" id="cmdk-list" role="listbox"></div><div class="cmdk-foot" aria-hidden="true"><span><kbd>↑↓</kbd> 미리 보기</span><span><kbd>Enter</kbd> 가기</span><span><kbd>Esc</kbd> 제자리</span></div>`
  host.append(el)
  const input = el.querySelector('input')!
  const list = el.querySelector('.cmdk-list') as HTMLElement
  requestAnimationFrame(() => el.classList.add('in'))

  const s = view.state
  const { a } = s.field(live)
  const peekTo = (pos: number) => view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), annotations: navigating.of(true) })
  // 고른 글자 · 커서 아래 이름 → 바로 검색어로
  const m = s.selection.main
  const picked = !m.empty && s.doc.lineAt(m.from).number === s.doc.lineAt(m.to).number ? s.sliceDoc(m.from, m.to).trim() : ''
  const under = symAt(s, m.head)
  const seed = o.here ? '' : picked.length && picked.length <= 60 ? picked : under && under.sym.kind !== 'std' && under.sym.kind !== 'builtin' ? under.sym.name : ''
  // 고칠 것: 이 줄 먼저, 그다음 파일 전체
  const curNo = s.doc.lineAt(m.head).number
  const fixItems: Item[] = a.holes
    .map(h => ({ h, no: s.doc.lineAt(Math.min(h.from, s.doc.length)).number }))
    .sort((x, y) => (x.no === curNo ? -1 : 0) - (y.no === curNo ? -1 : 0) || x.no - y.no)
    .map(({ h, no }) => ({
      kind: 'cmd' as const, key: `${h.msg} ${h.fix?.label ?? ''}`, tone: h.fix ? 'fix' : 'hole',
      title: h.fix ? h.fix.label : h.msg, sub: h.fix ? h.msg : '직접 고쳐야 해', right: `${no}줄`,
      run: () => {
        if (h.fix) view.dispatch({ changes: { from: h.fix.at, to: h.fix.to, insert: h.fix.insert }, userEvent: 'input.fix' })
        else view.dispatch({ selection: { anchor: h.from, head: h.to }, effects: EditorView.scrollIntoView(h.from, { y: 'center' }) })
        view.focus()
      },
    }))
  // 그 이름이 나오는 곳 전부 (이 파일)
  const siteItems = (name: string): Item[] => {
    const sym = under && under.sym.name === name ? under.sym : a.syms.find(x => x.name === name && x.from >= 0 && !x.file)
    if (!sym) return []
    return occurrences(s, sym).map(o => {
      const line = s.doc.lineAt(o.from)
      const n = nodeAt(a, line.number - 1)
      const where = n?.parent ? label(n.parent) : ''
      return {
        kind: 'site' as const, key: name, title: line.text.trim().slice(0, 64), tone: o.kind === 'def' ? 'def' : o.kind === 'w' ? 'w' : 'r',
        sub: `${o.kind === 'def' ? '정의' : o.kind === 'w' ? '바꿈' : '읽음'}${where ? ` · ${where}` : ''}`, right: `${line.number}줄`,
        peek: () => peekTo(o.from), run: () => {}, at: o.from,
      }
    })
  }
  const blocks: Item[] = a.blocks.map(b => {
    const sym = a.syms.find(x => x.line === b.from && x.name === b.name && x.from >= 0 && !x.file)
    const d = sym ? describe(a, s, sym) : undefined
    const kindWord = sym ? (KIND_WORD[sym.kind] ?? b.kind) : b.kind
    const tone = sym?.kind ?? b.kind
    return {
      kind: 'block', key: `${b.name} ${kindWord}`, title: b.name, sub: kindWord, tone,
      right: d?.value ? d.value.replace(/<[^>]+>/g, '') : `${b.from + 1}줄`,
      peek: () => { const l = view.state.doc.line(b.from + 1); peekTo(l.from + b.node.indent) },
      run: () => {},
    }
  })
  const files: Item[] = o.files.filter(f => f !== o.current).map(f => ({ kind: 'file', key: f, title: f, sub: '파일', right: '', tone: 'file', run: () => o.open(f) }))
  const cmds: Item[] = o.cmds.filter(c => c.palette !== false && c.id !== 'cmdk').map(c => ({
    kind: 'cmd', key: `${c.label} ${c.group}`, title: c.label, sub: c.group, right: kbd(c), tone: 'cmd',
    run: () => { view.focus(); c.run(view) },
  }))
  let others: Item[] | undefined
  const elsewhere = () => others ??= o.elsewhere().map(e => ({ kind: 'sym', key: `${e.name} ${e.file}`, title: e.name, sub: `${e.file} · ${KIND_WORD[e.kind] ?? e.kind}`, right: `${e.line + 1}줄`, tone: e.kind, run: () => o.open(e.file, e.line) }))

  let items: Item[] = [], sel = 0
  let startAt: number | undefined = under && seed === under.sym.name ? under.from : undefined
  const ctxCmds = () => o.cmds.filter(c => c.hint && (!c.when || c.when(view.state)) && c.id !== 'cmdk')
  function draw() {
    const raw = input.value.trim()
    const q = raw.toLowerCase()
    const sections: [string, Item[]][] = []
    const lineNo = /^:(\d+)$/.exec(raw)
    if (lineNo) {
      const n = Math.max(1, Math.min(view.state.doc.lines, +lineNo[1]))
      const l = view.state.doc.line(n)
      sections.push(['줄로 가기', [{ kind: 'line', key: raw, title: l.text.trim().slice(0, 64) || '(빈 줄)', sub: `${n}줄`, right: '', tone: 'line', peek: () => peekTo(l.from + (l.text.length - l.text.trimStart().length)), run: () => {} }]])
    } else if (raw.startsWith('>')) {
      const cq = q.slice(1).trim()
      const rank = (xs: Item[]) => xs.map(x => [score(cq, x.key), x] as const).filter(([sc]) => sc >= 0).sort((p, r) => r[0] - p[0]).map(([, x]) => x)
      sections.push(['할 일', rank(cmds)])
    } else if (o.here) {
      const rank = (xs: Item[]) => q ? xs.map(x => [score(q, x.key), x] as const).filter(([sc]) => sc >= 0).sort((p, r) => r[0] - p[0]).map(([, x]) => x) : xs
      const now = ctxCmds().filter(c => c.id !== 'here').sort((x, y) => (y.hint ?? 0) - (x.hint ?? 0)).map(c => c.label)
      sections.push([fixItems.length ? `고칠 것 · ${fixItems.length}` : '고칠 것 없음', rank(fixItems).slice(0, 8)])
      sections.push(['여기서', rank(now.map(l => cmds.find(c => c.title === l)!).filter(Boolean))])
      if (q) sections.push(['다른 할 일', rank(cmds.filter(c => !now.includes(c.title))).slice(0, 6)])
    } else if (!q) {
      const now = new Set(ctxCmds().map(c => c.label))
      sections.push(['이 파일', blocks])
      sections.push(['지금 할 수 있는 것', cmds.filter(c => now.has(c.title)).slice(0, 5)])
      sections.push(['파일', files])
    } else {
      const rank = (xs: Item[]) => xs.map(x => [score(q, x.key), x] as const).filter(([sc]) => sc >= 0).sort((p, r) => r[0] - p[0]).map(([, x]) => x)
      const sites = siteItems(raw)
      if (sites.length) sections.push([`${raw} 이 나오는 곳 · ${sites.length}`, sites])
      sections.push(['이 파일', rank(blocks).slice(0, 6)])
      sections.push(['다른 파일', rank([...files, ...elsewhere()]).slice(0, 6)])
      sections.push(['할 일', rank(cmds).slice(0, 6)])
    }
    items = []
    list.textContent = ''
    for (const [title, xs] of sections) {
      if (!xs.length) continue
      const h = document.createElement('div')
      h.className = 'cmdk-h'
      h.textContent = title
      list.append(h)
      for (const it of xs) {
        const i = items.length
        items.push(it)
        const r = document.createElement('div')
        r.className = `cmdk-row k-${it.tone}`
        r.setAttribute('role', 'option')
        r.id = `cmdk-o${i}`
        r.innerHTML = `<b>${esc(it.title)}</b><i>${esc(it.sub)}</i><span>${it.kind === 'cmd' ? it.right : esc(it.right)}</span>`
        r.onmousemove = () => { if (sel !== i) { sel = i; mark() } }
        r.onmousedown = e => { e.preventDefault(); sel = i; choose() }
        list.append(r)
      }
    }
    if (!items.length) { const e = document.createElement('div'); e.className = 'cmdk-none'; e.textContent = '없어. 다르게 쳐볼래?'; list.append(e) }
    if (startAt !== undefined) { const i = items.findIndex(x => x.at === startAt); if (i >= 0) sel = i; startAt = undefined }
    sel = Math.min(sel, Math.max(0, items.length - 1))
    mark()
  }
  function mark() {
    const rows = list.querySelectorAll('.cmdk-row')
    rows.forEach((r, i) => { r.classList.toggle('sel', i === sel); r.setAttribute('aria-selected', String(i === sel)) })
    rows[sel]?.scrollIntoView({ block: 'nearest' })
    if (rows[sel]) input.setAttribute('aria-activedescendant', rows[sel].id); else input.removeAttribute('aria-activedescendant')
    items[sel]?.peek?.()
  }
  function close(back: boolean) {
    if (back) view.dispatch({ selection: { anchor: home.anchor, head: home.head }, annotations: navigating.of(true) }), view.scrollDOM.scrollTop = home.top
    el.classList.remove('in')
    setTimeout(() => el.remove(), 160)
    view.focus()
  }
  function choose() {
    const it = items[sel]
    if (!it) return
    if (it.peek) { rememberAt(s, home.head); close(false); it.peek(); return }
    close(false)
    it.run()
  }
  input.addEventListener('input', () => { sel = 0; draw() })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = (sel + 1) % Math.max(1, items.length); mark() }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % Math.max(1, items.length); mark() }
    else if (e.key === 'Enter') choose()
    else if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) close(true)
    else return
    e.preventDefault()
  })
  input.addEventListener('blur', () => setTimeout(() => { if (el.isConnected && document.activeElement !== input) close(false) }, 80))
  input.value = seed
  draw()
  input.focus()
  input.select()
  // 키를 누른 그 순간 에디터가 포커스를 되찾는 경우 대비
  requestAnimationFrame(() => { if (el.isConnected && document.activeElement !== input) { input.focus(); input.select() } })
}

const esc = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
