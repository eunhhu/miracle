import { test, expect } from 'bun:test'
import { analyze } from '../src/core/analyze'
import { show } from '../src/core/types'

const holes = (src: string) => analyze(src).holes.map(h => h.msg)
const tyOf = (src: string, name: string) => { const a = analyze(src); return show(a.tyOf(a.syms.find(s => s.name === name)!)) }

test('타입이 다르면 그 자리에서 알려준다', () => {
  expect(holes('total: Number = "abc"')[0]).toContain('Number 자리인데')
  expect(holes('fn double(x: Int) -> Int = x * 2\ny: Text = double(3)')[0]).toContain('Text 자리인데 Int')
})

test('메서드는 그 타입에만 있다', () => {
  expect(holes('t: Text = read("a")\nn: Number = t.round()')[0]).toContain("Text 에는 'round' 가 없어")
  expect(holes('t: Text = "a"\nu: Text = t.upper()')).toEqual([])
  expect(holes('xs: Int[] = [1]\nn: Int = xs.count()')[0]).toContain('괄호 없이')
})

test('제네릭: 받는 자리가 결과 타입을 정한다', () => {
  const src = 'model U\n  name: Text\nusers: U[] = get("/api")\nfirst: U? = users.find(.name == "a")\nn: Text = first?.name ?? ""'
  expect(holes(src)).toEqual([])
  expect(tyOf(src, 'first')).toBe('U?')
})

test('없을 수도 있는 값은 확인하고 쓴다', () => {
  expect(holes('model P\n  name: Text\nps: P[] = []\np: P? = ps.first\nn: Text = p.name')[0]).toContain('없을 수도')
  expect(holes('model P\n  name: Text\nps: P[] = []\np: P? = ps.first\nfn f()\n  if p\n    log p.name')).toEqual([])
})

test('모델 만들기: 빠진 칸 · 틀린 칸', () => {
  expect(holes('model P\n  name: Text\n  price: Int\np: P = P(name: "a")')[0]).toContain('price')
  expect(holes('model P\n  name: Text\np: P = P(name: "a")\nx: Text = p.nmae')[0]).toContain('name?')
})

test('고르기 타입', () => {
  expect(holes('model Status = "pending" | "paid"\ns: Status = "paid"')).toEqual([])
  expect(holes('model Status = "pending" | "paid"\ns: Status = "nope"')[0]).toContain('Status')
})

test('처음 나온 이름에 = 이면 타입을 알아내 고쳐준다', () => {
  const h = analyze('fn f()\n  up = "a".upper()').holes[0]
  expect(h.auto).toBe(true)
  expect(h.fix?.insert).toBe(': Text')
})

test('바깥 API 는 use 없이 이름으로', () => {
  expect(holes('fn f()\n  t: Text = read("./a")\n  write("./b", t.upper())\n  r: Json = post("/api", t)')).toEqual([])
})
