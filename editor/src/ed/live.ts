// 에디터 상태: 문서 → 분석 → 살아 있는 세계. 문서가 바뀌어도 값은 이어진다.
import { StateField, StateEffect, type EditorState } from '@codemirror/state'
import { analyze, type Analysis, type Resolve } from '../core/analyze'
import { World } from '../core/run'

export interface Live { a: Analysis; w: World; file: string }

let resolver: Resolve = () => undefined
let currentFile = ''
export function setResolver(r: Resolve) { resolver = r }
export function setFile(f: string) { currentFile = f }

export const resetWorld = StateEffect.define<null>()
export const bump = StateEffect.define<number>()

function build(doc: string, prev?: Live): Live {
  const a = analyze(doc, resolver, currentFile)
  let w: World
  try { w = new World(a) } catch (e) { console.error(e); w = new World({ ...a, decls: new Map(), fns: new Map() }) }
  if (prev && prev.file === currentFile) carry(prev, w)
  return { a, w, file: currentFile }
}

/** 이전 세계에서 같은 선언의 값을 옮겨 온다 */
function carry(prev: Live, next: World) {
  if (prev.w.version === 0) return
  const same = new Set<string>()
  for (const [name, n] of next.a.decls) {
    const o = prev.a.decls.get(name)
    if (o && o.line.text.trim() === n.line.text.trim() && prev.w.globals.has(name)) same.add(name)
  }
  const snap = prev.w.snapshot()
  const g = snap.g.filter(([k]) => same.has(k))
  const clone = structuredClone({ g, l: snap.l })
  for (const [k, v] of clone.g) next.globals.set(k, v)
  for (const [k, m] of clone.l) next.locals.set(k, new Map(m))
  next.failLines = new Set(prev.w.failLines)
  next.log = prev.w.log.slice(-30)
  next.version = prev.w.version
}

export const live = StateField.define<Live>({
  create: s => build(s.doc.toString()),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(resetWorld)) return build(tr.state.doc.toString())
    if (tr.docChanged) return build(tr.state.doc.toString(), v)
    return v
  },
})

export const liveOf = (s: EditorState) => s.field(live)
