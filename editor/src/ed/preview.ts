// 블록 아래 미리보기. 블록 종류마다 "이게 실제로 뭘 하는지"를 그 자리에서.
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { Block } from '../core/analyze'
import { fmt, type V, type VNode, type World, type LogEntry } from '../core/run'
import { live } from './live'

export const hoverLine = StateEffect.define<number | null>()
export const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(hoverLine)) {
      if (e.value === null || e.value >= tr.state.doc.lines) return Decoration.none
      const l = tr.state.doc.line(e.value + 1)
      return Decoration.set([Decoration.line({ class: 'cm-src-hover' }).range(l.from)])
    }
    return tr.docChanged ? v.map(tr.changes) : v
  },
  provide: f => EditorView.decorations.from(f),
})

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function jump(view: EditorView, line0: number) {
  const l = view.state.doc.line(Math.min(line0 + 1, view.state.doc.lines))
  view.dispatch({ selection: { anchor: l.from + (/^ */.exec(l.text)![0].length) }, scrollIntoView: true })
  view.focus()
}

const SAFE = new Set('main div section article header footer nav aside h1 h2 h3 h4 p span strong em small ul ol li form label input textarea button a img time table tr td th hr br'.split(' '))

function mountNodes(view: EditorView, w: World, nodes: VNode[], parent: HTMLElement) {
  for (const n of nodes) parent.append(node(view, w, n))
}

function node(view: EditorView, w: World, n: VNode): Node {
  if (n.tag === '#text') return document.createTextNode(n.text ?? '')
  if (n.tag === '#error') { const e = h('span', 'pv-err', n.text); e.dataset.line = String(n.line); return e }
  if (n.tag === '#comp') {
    const e = h('div', 'pv-comp')
    e.dataset.name = n.comp!
    e.dataset.line = String(n.line)
    mountNodes(view, w, n.children, e)
    return e
  }
  const isUi = !SAFE.has(n.tag)
  const e = document.createElement(isUi ? 'div' : n.tag) as HTMLElement
  if (isUi) e.className = `ui-${n.tag}`
  e.dataset.line = String(n.line)
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k === 'class') e.classList.add(...String(v).split(/\s+/).filter(Boolean))
    else if (typeof v === 'boolean') { if (v) e.setAttribute(k, '') }
    else if (v !== null && v !== undefined) e.setAttribute(k, fmt(v))
  }
  if (n.text !== undefined && n.tag !== 'input') e.append(n.text)
  if (n.bind) {
    const inp = e as HTMLInputElement
    const cur = n.bind.get()
    inp.value = cur === null || cur === undefined ? '' : String(cur)
    inp.dataset.k = n.key
    inp.addEventListener('input', () => {
      const v: V = typeof cur === 'number' ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value
      n.bind!.set(v); w.emit()
    })
  }
  for (const [ev, f] of Object.entries(n.events)) {
    const name = ev.slice(2).toLowerCase()
    e.addEventListener(name === 'change' ? 'input' : name, x => { x.preventDefault(); x.stopPropagation(); w.fire(f) })
    e.classList.add('pv-live')
  }
  mountNodes(view, w, n.children, e)
  return e
}

function valueView(v: V): HTMLElement {
  if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
    const t = h('table', 'pv-table')
    const keys = [...new Set(v.flatMap(x => Object.keys(x).filter(k => k !== '__t')))]
    const hr = h('tr'); keys.forEach(k => hr.append(h('th', '', k))); t.append(hr)
    for (const x of v.slice(0, 8)) { const r = h('tr'); keys.forEach(k => r.append(h('td', '', fmt(x[k], 1)))); t.append(r) }
    if (v.length > 8) t.append(h('caption', '', `…+${v.length - 8}`))
    return t
  }
  if (Array.isArray(v) && !v.length) return h('div', 'pv-empty', '비어 있음')
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const d = h('div', 'pv-kv')
    if (v.__t) d.append(h('b', '', v.__t))
    for (const [k, x] of Object.entries(v)) if (k !== '__t') { const r = h('div'); r.append(h('i', '', k), h('span', '', fmt(x, 1))); d.append(r) }
    return d
  }
  return h('div', 'pv-big', fmt(v))
}

function sticker(e: LogEntry) {
  const s = h('div', `pv-log k-${e.kind}`)
  s.append(h('span', 'pv-log-t', e.text))
  if (e.changes?.length) s.append(h('span', 'pv-log-c', e.changes.join(' · ')))
  return s
}

export function renderPreview(el: HTMLElement, view: EditorView, b: Block) {
  const { w, a } = view.state.field(live)
  el.textContent = ''
  const card = h('div', `pv-card k-${b.node.kind}`)
  const tab = h('div', 'pv-tab')
  const body = h('div', 'pv-body')
  const foot = h('div', 'pv-foot')
  card.append(tab, body, foot)
  el.append(card)
  const n = b.node
  const inRange = (l?: number) => l !== undefined && l >= b.from && l <= b.to
  const say = (t: string, sub?: string) => { tab.append(h('b', '', t)); if (sub) tab.append(h('span', '', sub)) }

  try {
    if (n.kind === 'call' && (b.name === 'mount' || b.name === 'app')) {
      say('화면', '실제로 눌러 봐')
      const screen = h('div', 'pv-screen')
      mountNodes(view, w, w.renderApp(), screen)
      body.append(screen)
    } else if (n.kind === 'fn' && /^[A-Z]/.test(b.name)) {
      const inst = w.renderComponent(b.name)
      say(b.name, inst.length > 1 ? `쓰이는 곳 ${inst.length}개` : '')
      for (const i of inst) {
        const wrap = h('div', 'pv-inst')
        const props = Object.entries(i.props)
        if (props.length) wrap.append(h('div', 'pv-props', props.map(([k, v]) => `${k}=${fmt(v, 1)}`).join('  ')))
        const screen = h('div', 'pv-screen small')
        mountNodes(view, w, i.nodes, screen)
        wrap.append(screen)
        body.append(wrap)
      }
    } else if (n.kind === 'fn') {
      say(`${b.name}()`, '하는 일')
      const writes: string[] = []
      for (const [s, ls] of a.writes) if (ls.some(inRange) && (s.kind === 'decl' || s.kind === 'field') && !writes.includes(s.name)) writes.push(s.name)
      const row = h('div', 'pv-act')
      const run = h('button', 'pv-run', `▶ ${b.name}(${(n.params ?? []).map(p => fmt(w.example(p.type), 1)).join(', ')})`)
      run.onclick = () => w.fire({ __fn: true, node: n, scope: w.module }, (n.params ?? []).map(p => w.example(p.type)))
      row.append(run)
      if (writes.length) row.append(h('span', 'pv-writes', `바꾸는 것: ${writes.join(', ')}`))
      else row.append(h('span', 'pv-writes', '아무것도 안 바꿈'))
      if (n.catchNode) row.append(h('span', 'pv-writes', '실패하면 되돌리고 catch'))
      body.append(row)
    } else if (n.kind === 'model') {
      say(b.name, '모양')
      const ex = w.example({ name: b.name, list: false, opt: false, text: '', from: 0, to: 0 })
      const kv = valueView(ex)
      for (const c of n.children.filter(c => c.kind === 'computed')) {
        const r = h('div', 'computed')
        let v = ''
        try { v = fmt(w.member(ex, c.name!, false, w.module), 1) } catch (e) { v = String((e as Error).message) }
        r.append(h('i', '', c.name!), h('span', '', v))
        kv.append(r)
      }
      body.append(kv)
      for (const c of n.children.filter(c => c.kind === 'check')) {
        let ok = false
        try { ok = !!w.ev(c.value!, w.module, { subj: ex } as any) } catch { /* */ }
        body.append(h('div', `pv-check ${ok ? 'ok' : 'bad'}`, `${ok ? '지켜짐' : '깨짐'} · ${c.line.text.trim()}`))
      }
      let count = 0
      const seen = new Set<V>()
      const visit = (v: V) => { if (!v || typeof v !== 'object' || seen.has(v)) return; seen.add(v); if (v.__t === b.name) count++; for (const k in v) visit(v[k]) }
      for (const v of w.globals.values()) visit(v)
      body.append(h('div', 'pv-note', `지금 세계에 ${count}개`))
    } else if (n.kind === 'decl') {
      const p = w.peek(b.name)
      const writable = a.writable.has(b.name)
      const sym = a.syms.find(s => s.kind === 'decl' && s.name === b.name && !s.file)
      const wl = sym ? (a.writes.get(sym) ?? []) : []
      say(b.name, writable ? `바뀌는 값 · ${wl.length}곳에서 바꿈` : a.refs.some(r => r.from >= n.line.from && r.from < n.line.from + n.line.text.length && r.sym.kind === 'decl' && r.sym.name !== b.name) ? '계산 값 · 따라서 바뀜' : '고정 값')
      body.append(p.ok ? valueView(p.v) : h('div', 'pv-err', p.why))
      if (wl.length) {
        const r = h('div', 'pv-where')
        for (const l of wl) { const c = h('button', 'pv-chip', `${l + 1}줄`); c.onclick = () => jump(view, l); c.onmouseenter = () => view.dispatch({ effects: hoverLine.of(l) }); c.onmouseleave = () => view.dispatch({ effects: hoverLine.of(null) }); r.append(c) }
        body.append(r)
      }
    } else if (n.kind === 'call' && b.name === 'serve') {
      say('서버', '요청을 보내 봐')
      for (const r of w.routes) {
        const row = h('div', 'pv-route')
        row.append(h('span', `pv-method m-${r.method}`, r.method), h('span', 'pv-path', r.path))
        const go = h('button', 'pv-run', '보내기')
        go.onclick = () => w.request(r)
        row.append(go)
        if (r.node.binders?.length) { const bad = h('button', 'pv-run ghost', '틀린 모양'); bad.onclick = () => w.request(r, true); row.append(bad) }
        const last = w.lastResponse(r.node.no)
        if (last) row.append(h('span', `pv-resp k-${last.kind}`, last.text.split(' → ').slice(1).join(' → ')))
        row.onmouseenter = () => view.dispatch({ effects: hoverLine.of(r.node.no) })
        row.onmouseleave = () => view.dispatch({ effects: hoverLine.of(null) })
        body.append(row)
      }
    } else if (w.sources.some(s => s.node === n)) {
      const s = w.sources.find(s => s.node === n)!
      say(s.label, '언제 도나')
      const go = h('button', 'pv-run', `▶ 지금 일어난 셈 치기${n.ex ? ` (${fmt(w.ev(n.ex, w.module), 1)})` : ''}`)
      go.onclick = () => w.fireSource(s)
      body.append(go)
    } else {
      el.classList.add('none')
      return
    }
  } catch (e) {
    body.append(h('div', 'pv-err', String((e as Error)?.message ?? e)))
  }

  // 바깥과 닿는 줄: 성공/실패를 바꿔 볼 수 있다
  for (let l = b.from; l <= b.to; l++) {
    const line = a.tree.lines[l]
    const t = line?.body.find(t => t.k === 'ident' && a.std.get(t.text)?.kind === 'boundary')
    if (!t) continue
    const failing = w.failLines.has(l)
    const chip = h('button', `pv-flip${failing ? ' fail' : ''}`)
    chip.append(h('i', '', t.text), h('span', '', failing ? '실패로 둠' : a.tree.byLine[l]?.ex || a.tree.byLine[l]?.exArgs ? '예시로 성공' : '예시 없음'))
    chip.title = '눌러서 성공/실패를 바꿔 봐'
    chip.onclick = () => { failing ? w.failLines.delete(l) : w.failLines.add(l); w.emit() }
    chip.onmouseenter = () => view.dispatch({ effects: hoverLine.of(l) })
    chip.onmouseleave = () => view.dispatch({ effects: hoverLine.of(null) })
    foot.append(chip)
  }
  const showsScreen = (n.kind === 'call' && (b.name === 'mount' || b.name === 'app')) || (n.kind === 'fn' && /^[A-Z]/.test(b.name))
  const logs = w.log.filter(e => e.kind !== 'boundary' && (showsScreen || inRange(e.line))).slice(showsScreen ? -2 : -3)
  for (const e of logs) foot.append(sticker(e))
  if (!foot.childElementCount) foot.remove()

  // 미리보기 ↔ 코드
  card.addEventListener('mouseover', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
    if (t) view.dispatch({ effects: hoverLine.of(Number(t.dataset.line)) })
  })
  card.addEventListener('mouseleave', () => view.dispatch({ effects: hoverLine.of(null) }))
  card.addEventListener('dblclick', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
    if (t) jump(view, Number(t.dataset.line))
  })
}
