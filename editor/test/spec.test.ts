// 스펙 테스트: miracle/spec/*.mrc 가 언어의 정답지다.
//   줄 끝 `// 빈칸: 글자` → 그 줄에 그 글자를 담은 빈칸이 있어야 한다
//   표시 없는 줄 → 빈칸이 없어야 한다
//   `! 값` → 실행했을 때 그 값이어야 한다 (빈칸 줄은 빼고)
import { test, expect } from 'bun:test'
import { analyze } from '../src/core/analyze'
import { World } from '../src/core/run'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const dir = join(import.meta.dir, '../../spec/')
for (const f of readdirSync(dir).filter(f => f.endsWith('.mrc')).sort()) {
  test(`spec/${f}`, () => {
    const src = readFileSync(dir + f, 'utf8')
    const lines = src.split('\n')
    const want = new Map<number, string>()
    lines.forEach((l, i) => { const m = l.match(/\/\/\s*빈칸:\s*(.+)$/); if (m) want.set(i + 1, m[1].trim()) })
    const a = analyze(src)
    const got = new Map<number, string[]>()
    for (const h of a.holes) {
      const no = src.slice(0, Math.min(h.from, src.length)).split('\n').length
      got.set(no, [...(got.get(no) ?? []), h.msg])
    }
    const problems: string[] = []
    for (const [no, w] of want) if (!(got.get(no) ?? []).some(m => m.includes(w))) problems.push(`${no}줄: '${w}' 빈칸이 있어야 해 (실제: ${JSON.stringify(got.get(no) ?? [])})`)
    for (const [no, ms] of got) if (!want.has(no)) problems.push(`${no}줄: 빈칸이 없어야 해 (실제: ${JSON.stringify(ms)})`)
    const w = new World(a)
    for (const [no, e] of w.expectations()) if (!want.has(no + 1) && !want.has(no) && !e.ok) problems.push(`${no}줄 기대: 실제 ${e.got}`)
    expect(problems).toEqual([])
  })
}
