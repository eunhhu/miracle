// 에디터 상태: 문서 → 분석 → 커서 자리. 전부 문서에서 바로 계산된다.

import { StateField, StateEffect, type EditorState } from '@codemirror/state'
import { analyze, type Analysis, type Node } from '../lang/analyze'
import { here, symbols, type Here, type Sym } from '../lang/inspect'
import { Sim } from '../lang/sim'

export interface World { a: Analysis; syms: Map<string, Sym> }

export const world = StateField.define<World>({
  create: s => build(s.doc.toString()),
  update: (v, tr) => tr.docChanged ? build(tr.state.doc.toString()) : v,
})

function build(doc: string): World {
  const a = analyze(doc)
  return { a, syms: symbols(a) }
}

/** 미리보기 세계는 분석마다 하나. 문서를 고치면 가정 값에서 다시 시작 */
const sims = new WeakMap<Analysis, Sim>()
export function simOf(a: Analysis) {
  let s = sims.get(a)
  if (!s) sims.set(a, s = new Sim(a.roots))
  return s
}

export const hereField = StateField.define<Here>({
  create: s => compute(s),
  update: (v, tr) => tr.docChanged || tr.selection ? compute(tr.state) : v,
})

function compute(s: EditorState): Here {
  const { a, syms } = s.field(world)
  return here(a, s.selection.main.head, syms)
}

/** 미리보기 위에 마우스를 올린 소스 줄 (0부터) */
export const setHover = StateEffect.define<number | null>()
export const hoverLine = StateField.define<number | null>({
  create: () => null,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setHover)) return e.value; return tr.docChanged ? null : v },
})

/** 줄 번호(0부터)를 담고 있는 맨 바깥 블록 */
export function rootAt(a: Analysis, no: number): Node | undefined {
  for (const r of a.roots) if (r.line.no <= no && no <= lastLine(r)) return r
}
export function lastLine(n: Node): number {
  return n.children.length ? lastLine(n.children[n.children.length - 1]) : n.line.no
}
/** 줄을 담고 있는 가장 안쪽 노드 */
export function nodeAt(a: Analysis, no: number): Node | undefined {
  const walk = (ns: Node[]): Node | undefined => {
    for (const n of ns) if (n.line.no <= no && no <= lastLine(n)) return walk(n.children) ?? n
  }
  return walk(a.roots)
}
