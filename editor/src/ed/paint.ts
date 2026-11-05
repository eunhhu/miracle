// 색: 글자 종류 + 이름의 출처. 기호 대신 색과 굵기로.
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { lexLine } from '../core/lex'
import { live } from './live'
import type { Sym } from '../core/analyze'

const mk = (c: string) => Decoration.mark({ class: c })
const M: Record<string, Decoration> = {}
const m = (c: string) => (M[c] ??= mk(c))

export function symClass(s: Sym, writable: Set<string>): string {
  switch (s.kind) {
    case 'model': case 'case': return 't-model'
    case 'comp': return 't-comp'
    case 'fn': return 't-fn'
    case 'field': case 'computed': return 't-field'
    case 'decl': case 'local': return writable.has(s.name) ? 't-state' : 't-fixed'
    case 'param': case 'loop': case 'binder': case 'catch': return 't-param'
    case 'std': return s.std?.kind === 'tag' ? 't-tag' : 't-std'
    case 'builtin': return 't-std'
  }
  return ''
}

function build(view: EditorView): DecorationSet {
  const { a } = view.state.field(live)
  const b = new RangeSetBuilder<Decoration>()
  const refAt = new Map<number, string>()
  for (const r of a.refs) refAt.set(r.from, symClass(r.sym, a.writable) + (r.write ? ' t-write' : ''))
  for (const s of a.syms) if (s.line >= 0 && !s.file && s.from >= 0) refAt.set(s.from, (refAt.get(s.from) ?? symClass(s, a.writable)) + ' t-def')
  const holeAt = new Map<number, number>()
  for (const h of a.holes) holeAt.set(h.from, h.to)
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const toks = lexLine(line.text, line.from)
      const marks: [number, number, string][] = []
      let afterEx = false
      for (const t of toks) {
        let c = ''
        if (t.k === 'ex' || t.k === 'expect') { afterEx = true; c = t.k === 'ex' ? 't-exmark' : 't-expmark' }
        else if (t.k === 'comment') c = 't-comment'
        else if (t.k === 'kw') c = ['true', 'false', 'none'].includes(t.text) ? 't-lit' : 't-kw'
        else if (t.k === 'str') c = 't-str'
        else if (t.k === 'num' || t.k === 'time') c = 't-num'
        else if (t.k === 'const') c = 't-const'
        else if (t.k === 'op') c = ['=', '+=', '-='].includes(t.text) ? 't-assign' : 't-op'
        else if (t.k === 'punct') c = 't-punct'
        else if (t.k === 'ident' || t.k === 'type') {
          c = refAt.get(t.from) ?? (t.k === 'type' ? 't-type' : 't-name')
          const next = toks[toks.indexOf(t) + 1]
          if (t.k === 'ident' && next?.text === '=' && next.from === t.to && /^on[A-Z]|^bind$/.test(t.text)) c = 't-event'
          else if (t.k === 'ident' && next?.text === '=' && next.from === t.to && !refAt.has(t.from)) c = 't-attr'
        } else if (t.k === 'bad') c = 't-bad'
        if (afterEx && t.k !== 'ex' && t.k !== 'expect' && t.k !== 'comment') c += ' t-example'
        if (holeAt.has(t.from)) c += ' t-hole'
        if (c) marks.push([t.from, t.to, c.trim()])
      }
      for (const [f, t, c] of marks) if (t > f) b.add(f, t, m(c))
      pos = line.to + 1
    }
  }
  return b.finish()
}

export const paint = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(v: EditorView) { this.decorations = build(v) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.startState.field(live) !== u.state.field(live)) this.decorations = build(u.view)
  }
}, { decorations: v => v.decorations })
