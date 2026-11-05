// 실행 규칙: 되돌림 · catch 갈래 · match
import { test, expect } from 'bun:test'
import { analyze } from '../src/core/analyze'
import { World } from '../src/core/run'
import { readFileSync } from 'fs'
import { join } from 'path'

const g = (w: World, n: string) => (w as any).module.find(n).get()
const spec = (f: string) => readFileSync(join(import.meta.dir, '../../spec/', f), 'utf8')

test('실패하면 그 함수에서 바꾼 값이 되돌아가고 맞는 catch 갈래로 간다', () => {
  const w = new World(analyze(spec('12-fail.mrc')))
  w.fire(g(w, 'buy') as any, [5])
  expect(g(w, 'stock')).toBe(1)
  expect(g(w, 'error')).toBe('펜 재고가 부족해요')
})

test('catch 없는 사건 함수가 실패해도 값은 그대로', () => {
  const w = new World(analyze(spec('12-fail.mrc')))
  w.fire(g(w, 'shut') as any)
  expect(g(w, 'stock')).toBe(1)
  expect(w.log.some(l => l.kind === 'fail')).toBe(true)
})

test('경우 값 만들기와 match', () => {
  const w = new World(analyze(spec('10-cases.mrc')))
  expect(g(w, 'd')).toEqual({ __t: 'Dot', __of: 'Shape' })
  expect(g(w, 'area')).toBe(12)
})
