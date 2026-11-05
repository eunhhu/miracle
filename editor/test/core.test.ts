import { test, expect } from 'bun:test'
import { analyze } from '../src/core/analyze'
import { World, fmt, type VNode } from '../src/core/run'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'

const root = join(import.meta.dir, '../../examples/')
const resolve = (from: string | undefined, path: string) => {
  const f = join(dirname(from ?? root + 'x'), path + '.mrc')
  return existsSync(f) ? { file: f, text: readFileSync(f, 'utf8') } : undefined
}
const load = (name: string) => {
  const file = root + name + '.mrc'
  const a = analyze(readFileSync(file, 'utf8'), resolve, file)
  return { a, w: new World(a) }
}
const find = (ns: VNode[], p: (n: VNode) => boolean): VNode | undefined => {
  for (const n of ns) { if (p(n)) return n; const c = find(n.children, p); if (c) return c }
}
const text = (ns: VNode[]): string => ns.map(n => (n.text ?? '') + ' ' + text(n.children)).join(' ')

for (const name of ['cart', 'users/client', 'users/server', 'users/user', 'chat', 'sync', 'sample2']) {
  test(`${name}: 빈칸 없이 읽히고 세계가 뜬다`, () => {
    const { a, w } = load(name)
    expect(a.holes.map(h => h.msg)).toEqual([])
    for (const [k] of a.decls) expect(w.peek(k).ok).toBe(true)
    for (const [, e] of w.expectations()) expect(e.ok).toBe(true)
  })
}

test('cart: 재고 부족이면 되돌리고, 재고를 채우면 주문된다', () => {
  const { w } = load('cart')
  const order = () => find(w.renderApp(), n => n.text === '주문하기')!
  w.fire(order().events.onClick)
  expect(text(w.renderApp())).toContain('펜 재고가 부족해요')
  expect((w.peek('cart') as any).v[0].qty).toBe(3)   // 되돌림
  const products = (w.peek('products') as any).v
  products[0].stock = 6
  w.fire(order().events.onClick)
  expect(fmt((w.peek('orders') as any).v, 1)).not.toBe('[]')
  expect((w.peek('products') as any).v[0].stock).toBe(3)
})

test('users/server: 틀린 모양 요청은 거절된다', () => {
  const { w } = load('users/server')
  const post = w.routes.find(r => r.method === 'POST')!
  const ok = w.request(post), bad = w.request(post, true)
  expect(ok.text).not.toContain('422')
  expect(bad.text).toContain('422')
})
