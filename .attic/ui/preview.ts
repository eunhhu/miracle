// 유닛 미리보기: interface · component · model 블록을 그 자리에서 실제로 그린다.
// 버튼을 누르면 Sim 이 사건을 일으키고, 모든 미리보기가 같은 세계를 보고 다시 그려진다.

import { Parser } from '../lang/expr'
import { fmt, plain, isObj, items, isHole, truthyV, type Node, type V, type Obj } from '../lang/analyze'
import type { Sim } from '../lang/sim'

export interface PreviewHooks {
  /** 미리보기 요소 → 소스 줄 */
  jump(line: number): void
  hover(line: number | null): void
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

const show = (v: V) => isHole(v) ? '◌' : plain(v)

interface Ctx { sim: Sim; iface: string; comp?: string; subj?: V; hooks: PreviewHooks; depth: number }

/** 블록 하나를 그린다. 그릴 게 없으면 undefined */
export function renderUnit(root: Node, sim: Sim, hooks: PreviewHooks): HTMLElement | undefined {
  const name = root.line.main[1]?.text ?? ''
  switch (root.head) {
    case 'interface': return renderInterface(root, name, sim, hooks)
    case 'component': return renderComponentUnit(root, name, sim, hooks)
    case 'model': return renderModel(root, name, sim, hooks)
  }
}

// ── interface ───────────────────────────────────────────

function renderInterface(root: Node, name: string, sim: Sim, hooks: PreviewHooks) {
  const wrap = h('div', 'pv')
  const screens = root.children.filter(c => c.head === 'screen')
  const rest = root.children.filter(c => c.head !== 'screen')
  const stage = h('div', 'pv-stage')
  for (const s of screens) stage.appendChild(el(s, { sim, iface: name, hooks, depth: 0 }))
  if (rest.length) {
    const dev = h('div', 'pv-device')
    for (const c of rest) dev.appendChild(el(c, { sim, iface: name, hooks, depth: 0 }))
    stage.appendChild(dev)
  }
  wrap.appendChild(stage)
  wrap.appendChild(footer(sim))
  return wrap
}

/** 방금 일어난 일 + 처음 값으로 */
function footer(sim: Sim) {
  const f = h('div', 'pv-foot')
  const last = sim.log.slice(-3)
  if (!last.length) f.appendChild(h('span', 'pv-dim', '버튼을 눌러 봐. 진짜로 돈다'))
  for (const e of last) {
    const row = h('span', e.ok ? 'pv-ev ok' : 'pv-ev bad')
    row.textContent = e.system
      ? `${e.ok ? '✓' : '✗'} ${e.system}${e.fail ? ` · ${e.fail} 로 되돌림` : e.changes.length ? ` · ${e.changes.slice(0, 2).join(' · ')}` : ''}`
      : `${e.trigger} · ${e.changes[0]}`
    f.appendChild(row)
  }
  const reset = h('button', 'pv-reset', '↺ 처음 값')
  reset.title = '가정 값으로 되돌리기'
  reset.onclick = e => { e.stopPropagation(); sim.reset() }
  f.appendChild(reset)
  return f
}

// ── component 단독 ──────────────────────────────────────

function renderComponentUnit(root: Node, name: string, sim: Sim, hooks: PreviewHooks) {
  const of = attr(root.line.main, 'of')
  const subjects = of ? sim.w.instancesOf(of).slice(0, 4) : [undefined]
  const wrap = h('div', 'pv')
  const stage = h('div', 'pv-stage pv-row')
  for (const s of subjects) {
    const cell = h('div', 'pv-cell')
    if (s && isObj(s)) cell.appendChild(h('div', 'pv-label', s.name ? `? ${s.name}` : fmt(s)))
    for (const c of root.children) if (c.head !== 'system') cell.appendChild(el(c, { sim, iface: name, comp: name, subj: s, hooks, depth: 0 }))
    stage.appendChild(cell)
  }
  if (of && !subjects.length) stage.appendChild(h('div', 'pv-dim', `${of} 가정 값이 없어. model ${of} 안에 ? 줄을 넣으면 여기 그려져`))
  wrap.appendChild(stage)
  wrap.appendChild(footer(sim))
  return wrap
}

// ── model: 지금 세계의 인스턴스 표 ─────────────────────

function renderModel(root: Node, name: string, sim: Sim, hooks: PreviewHooks) {
  const def = sim.w.models.get(name)
  if (!def) return undefined
  const rows: Obj[] = def.single ? [sim.w.singles.get(name)!] : sim.w.instancesOf(name)
  const cols = [...def.fields.values()]
  const wrap = h('div', 'pv pv-model')
  const table = h('table', 'pv-table')
  const thead = h('tr')
  thead.appendChild(h('th', '', ''))
  for (const c of cols) {
    const th = h('th', c.derived ? 'derived' : '', c.name)
    th.onclick = () => hooks.jump(c.line.no)
    thead.appendChild(th)
  }
  table.appendChild(thead)
  for (const o of rows) {
    const tr = h('tr')
    tr.appendChild(h('td', 'pv-name', o.name ?? (def.single ? name : '·')))
    for (const c of cols) {
      const v = c.name in o.f ? o.f[c.name] : c.derived ? sim.w.eval(c.derived, { subj: o }) : null
      tr.appendChild(h('td', c.derived ? 'derived' : '', v === null || v === undefined ? '' : fmt(v)))
    }
    table.appendChild(tr)
  }
  if (!rows.length) {
    const tr = h('tr')
    const td = h('td', 'pv-dim', `아직 ${name} 가 없어. ? 이름  칸=값 줄을 넣어 봐`)
    td.colSpan = cols.length + 1
    tr.appendChild(td)
    table.appendChild(tr)
  }
  wrap.appendChild(table)
  return wrap
}

// ── 줄 하나 → 요소 ──────────────────────────────────────

function el(n: Node, ctx: Ctx): HTMLElement {
  const m = n.line.main
  const head = n.head
  const ev = (i: number) => {
    const p = new Parser(m.slice(i))
    return ctx.sim.w.eval(p.primary(), { subj: ctx.subj })
  }
  const attrsAt = (i: number) => uiAttrs(m, i)
  const at = (key: string, from: number) => {
    const a = attrsAt(from).find(x => x.key === key)
    return a ? ctx.sim.w.eval(a.value, { subj: ctx.subj }) : undefined
  }
  const flags = new Set(m.slice(1).filter(l => l.k === 'ident' && !m.some((x, i) => i > 0 && m[i - 1] === l && x.text === '=')).map(l => l.text))

  let out: HTMLElement
  switch (head) {
    case 'screen': {
      out = h('div', 'pv-screen')
      const title = m[1]?.k === 'str' ? show(ev(1)) : ''
      if (title) out.appendChild(h('div', 'pv-title', title))
      const body = h('div', 'pv-body')
      n.children.forEach(c => body.appendChild(el(c, ctx)))
      out.appendChild(body)
      break
    }
    case 'card': case 'row': case 'stack': case 'col': {
      out = h('div', `pv-${head}`)
      n.children.forEach(c => out.appendChild(el(c, ctx)))
      break
    }
    case 'list': {
      out = h('div', 'pv-list')
      const of = at('of', 2)
      let xs = [...(items(of ?? null) ?? [])]
      const sortTok = uiAttrs(m, 2).find(a => a.key === 'sort')
      if (sortTok && sortTok.value.t === 'path') {
        const k = sortTok.value.root
        xs.sort((p, q) => plain(isObj(p) ? p.f[k] ?? null : null).localeCompare(plain(isObj(q) ? q.f[k] ?? null : null)))
      }
      if (!xs.length) out.appendChild(h('div', 'pv-empty', '비어 있음'))
      for (const x of xs) {
        const item = h('div', 'pv-item')
        n.children.forEach(c => item.appendChild(el(c, { ...ctx, subj: x })))
        out.appendChild(item)
      }
      break
    }
    case 'text': case 'time': {
      const v = m[1] ? ev(1) : ''
      out = h('div', 'pv-text', show(v))
      if (flags.has('bold')) out.classList.add('bold')
      if (flags.has('muted') || head === 'time') out.classList.add('muted')
      if (isHole(v)) out.classList.add('hole')
      break
    }
    case 'input': {
      const key = `${ctx.iface}.${m[1]?.text}`
      const inp = h('input', 'pv-input') as HTMLInputElement
      const v = ctx.sim.w.ports.get(key)
      inp.value = v === undefined || isHole(v) ? '' : plain(v)
      inp.placeholder = show(at('placeholder', 2) ?? '')
      inp.dataset.key = key
      inp.oninput = () => ctx.sim.setPort(key, inp.value)
      inp.onclick = e => e.stopPropagation()
      out = inp
      break
    }
    case 'button': {
      const nameTok = m[1]?.text ?? ''
      const label = m[2]?.k === 'str' ? show(ev(2)) : nameTok
      const disabled = truthyV(at('disabled', 3) ?? false)
      const visible = at('visible', 3)
      const b = h('button', 'pv-button', label) as HTMLButtonElement
      if (visible !== undefined && !truthyV(visible)) { b.classList.add('pv-hidden'); b.title = 'visible = 거짓' }
      b.disabled = disabled
      const trigger = ctx.comp ? `${ctx.comp}.${nameTok}` : `${ctx.iface}.${nameTok}`
      const n2 = ctx.sim.systemsFor(trigger).length
      if (!n2) b.classList.add('pv-dead')
      b.title = n2 ? `${trigger} → ${ctx.sim.systemsFor(trigger).map(s => s.name).join(', ')}` : `${trigger} 를 받는 system 이 아직 없어`
      b.onclick = e => {
        e.stopPropagation()
        if (e.metaKey || e.ctrlKey) return ctx.hooks.jump(n.line.no)
        ctx.sim.fire(trigger, ctx.subj)
      }
      out = b
      break
    }
    case 'notice': {
      const key = `${ctx.iface}.${m[1]?.text}`
      const v = ctx.sim.w.ports.get(key)
      out = h('div', 'pv-notice')
      if (v !== undefined && !isHole(v) && truthyV(v)) {
        out.textContent = plain(v)
        const x = h('button', 'pv-x', '✕')
        x.onclick = e => { e.stopPropagation(); ctx.sim.setPort(key, '') }
        out.appendChild(x)
      } else {
        out.classList.add('pv-ghost')
        out.textContent = `${m[1]?.text ?? 'notice'} · 비어 있음`
      }
      break
    }
    case 'value': case 'read': {
      const key = `${ctx.iface}.${m[1]?.text}`
      const v = ctx.sim.w.ports.get(key)
      out = h('div', 'pv-port')
      out.append(h('i', '', head === 'value' ? '들어오는 값' : '읽기'), h('b', '', m[1]?.text ?? ''), h('span', '', v === undefined ? '◌' : fmt(v)))
      break
    }
    case 'watch': {
      const key = `${ctx.iface}.${m[1]?.text}`
      out = h('div', 'pv-port')
      out.append(h('i', '', '사건'), h('b', '', m[1]?.text ?? ''), h('span', '', m[2]?.k === 'str' ? show(ev(2)) : ''))
      const b = h('button', 'pv-fire', '일으키기 ▶')
      b.onclick = e => { e.stopPropagation(); ctx.sim.fire(key) }
      out.appendChild(b)
      break
    }
    case 'call': {
      out = h('div', 'pv-port')
      out.append(h('i', '', '나가는 사건'), h('b', '', m[1]?.text ?? ''), h('span', '', m.slice(2).map(l => l.text).join(' ')))
      break
    }
    default: {
      // 대문자로 시작하면 component 를 여기 꽂은 것
      const comp = ctx.sim.w.components.get(head)
      if (comp && ctx.depth < 6) {
        out = h('div', 'pv-use')
        const of = uiAttrs(m, 1).find(a => a.key === 'of')
        const subj = of ? ctx.sim.w.eval(of.value, { subj: ctx.subj }) : ctx.subj
        comp.node.children.filter(c => c.head !== 'system').forEach(c => out.appendChild(el(c, { ...ctx, comp: comp.name, subj, depth: ctx.depth + 1 })))
      } else {
        out = h('div', 'pv-unknown', n.line.text.trim())
      }
    }
  }
  out.dataset.line = String(n.line.no)
  out.addEventListener('mouseenter', () => ctx.hooks.hover(n.line.no))
  out.addEventListener('mouseleave', () => ctx.hooks.hover(null))
  if (out.tagName !== 'BUTTON' && out.tagName !== 'INPUT') out.addEventListener('click', e => { e.stopPropagation(); ctx.hooks.jump(n.line.no) })
  return out
}

/** 화면 줄 속성: key=값 이 나란히. 값은 다음 key= 앞까지 */
function uiAttrs(m: Node['line']['main'], from: number) {
  const keys: number[] = []
  for (let i = from; i < m.length - 1; i++) if (m[i].k === 'ident' && m[i + 1].text === '=' && m[i + 2]?.text !== '=') keys.push(i)
  return keys.map((k, j) => {
    const toks = m.slice(k + 2, keys[j + 1] ?? m.length)
    try { return { key: m[k].text, value: new Parser(toks).expr() } } catch { return { key: m[k].text, value: new Parser(toks.slice(0, 1)).primary() } }
  })
}

function attr(m: Node['line']['main'], key: string) {
  const i = m.findIndex((l, j) => l.text === key && m[j + 1]?.text === '=')
  return i >= 0 ? m[i + 2]?.text : undefined
}
