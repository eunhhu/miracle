// 글씨 위의 정보: 같은 이름 강조, 커서 렌즈, 줄 끝 살아 있는 값.
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { live } from './live'
import { fmt } from '../core/run'
import type { Analysis, Sym, Hole } from '../core/analyze'
import { membersOf, memberTy, resolve, show, known, type Ty } from '../core/types'
import { focusBlock } from './block'

export const KIND_WORD: Record<string, string> = {
  model: '모델 · 데이터 모양', field: '칸', computed: '계산 칸', decl: '상태', local: '이 안의 상태', param: '받는 값',
  fn: '함수 · 하는 일', comp: '컴포넌트 · 화면 조각', binder: '요청에서 받은 값', loop: '하나씩', catch: '실패 이유', std: 'std', builtin: '기본 함수', type: '타입',
}

export function symAt(state: EditorState, pos: number): { sym: Sym; from: number; to: number } | undefined {
  const { a } = state.field(live)
  const r = a.refs.find(r => pos >= r.from && pos <= r.to)
  if (r) return { sym: r.sym, from: r.from, to: r.to }
  const s = a.syms.find(s => !s.file && s.from >= 0 && pos >= s.from && pos <= s.to)
  if (s) return { sym: s, from: s.from, to: s.to }
}

export function describe(a: Analysis, state: EditorState, s: Sym): { title: string; kind: string; type?: string; value?: string; more?: string } {
  const { w } = state.field(live)
  let kind = KIND_WORD[s.kind] ?? s.kind
  let value: string | undefined, more: string | undefined
  if (s.kind === 'decl') {
    const p = w.peek(s.name)
    value = p.ok ? fmt(p.v, 1) : `⚠ ${p.why}`
    const wl = [...a.writes].find(([x]) => x.name === s.name && x.kind === 'decl')?.[1] ?? []
    kind = a.writable.has(s.name) ? '상태 · 바뀌는 값' : s.node?.value && a.refs.some(r => r.from > s.to && r.from < (s.node!.line.from + s.node!.line.text.length) && r.sym.kind === 'decl' && r.sym !== s) ? '계산 값 · 따라서 바뀜' : '고정 값'
    if (wl.length) more = `바꾸는 곳 ${wl.map(l => l + 1).join(', ')}줄`
  }
  if (s.kind === 'std' || s.kind === 'builtin') { kind = s.std?.kind === 'tag' ? '화면 부품' : s.std?.kind === 'boundary' ? '바깥과 닿음 · 줄 끝 ? 예시로 돈다' : s.std?.kind === 'source' ? '사건의 출처' : '기본 함수'; more = s.std?.doc; value = s.std?.sig }
  if (s.kind === 'fn' || s.kind === 'comp') {
    const n = s.node
    const ps = (n?.params ?? []).map(p => `${p.name}: ${p.type?.text ?? '?'}`).join(', ')
    value = ps ? `(${ps})` : undefined
    if (s.kind === 'fn') {
      const ch: string[] = []
      const last = n ? Math.max(n.no, ...[...a.tree.lines].filter(l => l.no > n.no && !l.blank && l.indent > n.indent).map(l => l.no)) : 0
      for (const [x, ls] of a.writes) if (n && ls.some(l => l > n.no && l <= last) && !ch.includes(x.name)) ch.push(x.name)
      more = ch.length ? `바꾸는 것: ${ch.join(', ')}` : '아무것도 안 바꿈'
    }
  }
  if (s.kind === 'field' || s.kind === 'computed') kind = `${s.owner} 의 ${KIND_WORD[s.kind]}`
  if (s.file) more = `${more ? more + ' · ' : ''}${s.file.split('/').slice(-2).join('/')} 에서 옴`
  return { title: s.name, kind, type: s.type?.text, value, more }
}

// ── 부르는 중: 받는 것들을 그 자리에 ──
/** 커서가 f( … ) 안이면: 이름(받는 것: 타입, …) → 결과, 지금 채우는 칸은 굵게 */
export function signatureAt(a: Analysis, st: EditorState, head: number): string | undefined {
  const line = st.doc.lineAt(head)
  const before = line.text.slice(0, head - line.from)
  let d = 0, open = -1, idx = 0
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i]
    if (c === '"') { const j = before.lastIndexOf('"', i - 1); if (j < 0) return; i = j; continue }
    if (c === ')' || c === ']') d++
    else if (c === '[') { if (d === 0) return; d-- }
    else if (c === '(') { if (d === 0) { open = i; break } d-- }
    else if (c === ',' && d === 0) idx++
  }
  if (open < 0) return
  const callee = /([\p{L}_][\p{L}\p{N}_]*(?:\??\.[\p{L}_][\p{L}\p{N}_]*)*)$/u.exec(before.slice(0, open))?.[1]
  if (!callee) return
  const no = line.number - 1
  let ft: Ty | undefined, name = callee, each: number | undefined, doc = ''
  const dot = callee.lastIndexOf('.')
  if (dot > 0) {
    const objT = resolve(a.tyOfText(callee.slice(0, dot).replace(/\?$/, ''), no))
    const inner = objT.k === 'opt' ? resolve(objT.of) : objT
    const { list, s } = membersOf(inner)
    const m = list.find(x => x.name === callee.slice(dot + 1))
    if (m) { ft = memberTy(m, s); each = m.each; doc = m.doc }
    name = callee.slice(dot + 1)
  } else {
    ft = resolve(a.tyOfText(callee, no))
    const sym = a.scopeAt(no).find(x => x.name === callee)
    doc = sym?.doc ?? a.std.get(callee)?.doc ?? ''
    if (sym?.kind === 'model') {
      const fs = a.fieldsOf(callee).filter(f => f.kind === 'field')
      ft = { k: 'fn', params: fs.map(f => ({ name: f.name, ty: a.tyOf(f) })), ret: { k: 'model', n: callee } }
    }
  }
  if (!ft || ft.k !== 'fn') return
  const ps = ft.params.map((p, i) => {
    const txt = esc(`${p.name ? p.name + ': ' : ''}${show(p.ty).replace(/\) -> /g, ') → ')}${i === each ? '  ← .칸 으로' : ''}`)
    return i === idx ? `<u>${txt}</u>` : txt
  }).join(', ')
  const ret = ft.ret.k === 'void' ? '' : ` → ${esc(show(ft.ret))}`
  const fails = ft.fails ? ' <s>실패 가능 · catch</s>' : ''
  return `<b>${esc(name)}</b><span>(${ps})${ret}</span>${fails}${doc ? `<small>${esc(doc)}</small>` : ''}`
}
void known

// ── 같은 이름 ──
const same = Decoration.mark({ class: 'cm-same' })
const sameW = Decoration.mark({ class: 'cm-same w' })
const sameDef = Decoration.mark({ class: 'cm-same d' })

// ── 렌즈 ──
export const typing = StateEffect.define<boolean>()
const typingField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) { for (const e of tr.effects) if (e.is(typing)) return e.value; return tr.docChanged ? true : v },
})

class Lens extends WidgetType {
  constructor(readonly html: string, readonly kind: string) { super() }
  eq(o: Lens) { return o.html === this.html }
  toDOM() { const d = document.createElement('span'); d.className = `lens k-${this.kind}`; d.innerHTML = this.html; return d }
  ignoreEvent() { return false }
}
class Ghost extends WidgetType {
  constructor(readonly text: string, readonly cls: string, readonly fix?: Hole['fix']) { super() }
  eq(o: Ghost) { return o.text === this.text && o.cls === this.cls }
  toDOM(view: EditorView) {
    const d = document.createElement('span'); d.className = `ghost ${this.cls}`; d.textContent = this.text
    if (this.fix) {
      const b = document.createElement('button'); b.className = 'ghost-fix'; b.textContent = this.fix.label
      const f = this.fix
      b.onmousedown = e => { e.preventDefault(); view.dispatch({ changes: { from: f.at, to: f.to, insert: f.insert }, userEvent: 'input.fix' }) }
      d.append(b)
    }
    return d
  }
  ignoreEvent() { return true }
}

const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

function build(view: EditorView): DecorationSet {
  const st = view.state
  const { a, w } = st.field(live)
  const head = st.selection.main.head
  const curLine = st.doc.lineAt(head)
  const out: { from: number; to: number; d: Decoration }[] = []

  const hit = symAt(st, head)
  if (hit) {
    const target = hit.sym
    const isSame = (s: Sym) => s === target || (s.name === target.name && s.kind === target.kind && s.line === target.line)
    for (const r of a.refs) if (isSame(r.sym)) out.push({ from: r.from, to: r.to, d: r.write ? sameW : same })
    if (target.from >= 0 && !target.file) out.push({ from: target.from, to: target.to, d: sameDef })
  }

  // 줄 끝: 살아 있는 값 · 기대 · 빈칸
  const exp = w.expectations()
  const holesByLine = new Map<number, Hole>()
  for (const hh of a.holes) { const l = st.doc.lineAt(Math.min(hh.from, st.doc.length)).number; if (!holesByLine.has(l)) holesByLine.set(l, hh) }
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = st.doc.lineAt(pos)
      const no = line.number - 1
      const node = a.tree.byLine[no]
      let g: Ghost | undefined
      const hole = holesByLine.get(line.number)
      if (hole && line.number === curLine.number && (st.field(typingField) || /[.(,=:]\s*$/.test(st.sliceDoc(line.from, head)))) g = undefined
      else if (hole) g = new Ghost(hole.msg, 'hole', hole.fix)
      else if (exp.has(no)) { const e = exp.get(no)!; g = new Ghost(e.ok ? '맞아' : `지금 ${e.got}`, e.ok ? 'ok' : 'bad') }
      else if (node?.kind === 'decl' && line.number !== curLine.number) {
        const p = w.peek(node.name!)
        if (p.ok) g = new Ghost(`${fmt(p.v, 1)}`, a.writable.has(node.name!) ? 'val state' : 'val')
      }
      if (g && !(line.number === curLine.number && !hole && !exp.has(no))) out.push({ from: line.to, to: line.to, d: Decoration.widget({ widget: g, side: 2 }) })
      pos = line.to + 1
    }
  }

  // 렌즈
  // 판 아래 카드가 이미 보여주는 것(블록 자신의 이름)은 렌즈로 다시 말하지 않는다
  const fb = st.field(focusBlock)
  const own = !!hit && !!fb && hit.sym.line === fb.from && hit.sym.from >= 0 && !hit.sym.file && ['decl', 'model', 'fn', 'comp'].includes(hit.sym.kind)
  const sigHint = st.selection.main.empty ? signatureAt(a, st, head) : undefined
  if (sigHint) out.push({ from: curLine.to, to: curLine.to, d: Decoration.widget({ widget: new Lens(sigHint, 'sig'), side: 3 }) })
  else if (hit && own) { /* 카드가 말한다 */ }
  else if (hit && !st.field(typingField) && st.selection.main.empty) {
    const d = describe(a, st, hit.sym)
    let html = `<i>${esc(d.kind)}</i><b>${esc(d.title)}</b>`
    if (d.type) html += `<em>${esc(d.type)}</em>`
    if (d.value) html += `<code>${esc(d.value)}</code>`
    if (d.more) html += `<small>${esc(d.more)}</small>`
    out.push({ from: curLine.to, to: curLine.to, d: Decoration.widget({ widget: new Lens(html, hit.sym.kind), side: 3 }) })
  } else if (!st.field(typingField) && st.selection.main.empty) {
    // 키워드에 커서: 말로 설명
    const word = st.wordAt(head)
    const KW: Record<string, string> = {
      model: '데이터 모양을 정한다. 칸 이름 + 타입, 줄 끝 ? 은 예시', fn: '대문자면 화면 조각, 소문자면 하는 일', use: '다른 파일·std 에서 이름을 가져온다',
      for: '목록을 하나씩. 화면 안에선 하나씩 그린다', if: '조건이 맞을 때만', else: '아니면 / 모양이 안 맞으면', catch: '실패하면 이 fn 의 변경을 전부 되돌리고 여기로',
      fail: '여기서 실패. 가장 가까운 catch 로 간다', check: '이 모델이 늘 지켜야 하는 규칙. 깨지면 바꾼 게 되돌려진다',
    }
    const t = word && st.sliceDoc(word.from, word.to)
    if (t && KW[t]) out.push({ from: curLine.to, to: curLine.to, d: Decoration.widget({ widget: new Lens(`<i>키워드</i><b>${t}</b><small>${esc(KW[t])}</small>`, 'kw'), side: 3 }) })
    else if (!curLine.text.trim()) out.push({ from: curLine.to, to: curLine.to, d: Decoration.widget({ widget: new Ghost('/ 만들기', 'hint'), side: 3 }) })
  }

  out.sort((x, y) => x.from - y.from || (x.d.startSide - y.d.startSide))
  const b = new RangeSetBuilder<Decoration>()
  for (const o of out) b.add(o.from, o.to, o.d)
  return b.finish()
}

export const lens = [
  typingField,
  ViewPlugin.fromClass(class {
    decorations: DecorationSet
    timer = 0
    constructor(readonly view: EditorView) { this.decorations = build(view) }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        clearTimeout(this.timer)
        this.timer = window.setTimeout(() => this.view.dispatch({ effects: typing.of(false) }), 700)
      }
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.length) this.decorations = build(u.view)
    }
    destroy() { clearTimeout(this.timer) }
  }, { decorations: v => v.decorations }),
  EditorView.updateListener.of(u => {
    if (u.selectionSet && !u.docChanged && u.state.field(typingField)) queueMicrotask(() => u.view.dispatch({ effects: typing.of(false) }))
  }),
]
