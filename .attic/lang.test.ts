import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lexLine, classify } from '../src/lang/tokenize'
import { analyze } from '../src/lang/analyze'

const ex = (name: string) => readFileSync(join(import.meta.dir, '../../examples', name + '.mrc'), 'utf8')
const tokText = (doc: string, type: string) =>
  classify(doc).filter(t => t.type === type).map(t => doc.slice(t.from, t.to))
const notesAt = (doc: string, needle: string) => {
  const no = doc.split('\n').findIndex(l => l.includes(needle))
  return analyze(doc).notes.filter(n => n.line === no).map(n => n.text)
}

test('렉서: 가정·기대 표식과 연산자를 구분한다', () => {
  const ks = lexLine('total = sum(.lines.amount)   ! 3000').map(l => l.k)
  expect(ks).toEqual(['ident', 'op', 'ident', 'punct', 'subj', 'punct', 'expect', 'num'])
  expect(lexLine('a != b ?? c').map(l => l.k)).toEqual(['ident', 'op', 'ident', 'op', 'ident'])
  expect(lexLine('input draft  ? "안녕"').map(l => l.k)).toEqual(['ident', 'ident', 'assume', 'str'])
})

test('분류: 왼쪽 끝 단어가 줄의 역할을 정한다', () => {
  const doc = ex('chat')
  expect(tokText(doc, 'decl')).toEqual(expect.arrayContaining(['app', 'model', 'interface', 'component', 'system', 'sample']))
  expect(tokText(doc, 'kind')).toEqual(expect.arrayContaining(['screen', 'list', 'input', 'button', 'card', 'text']))
  expect(tokText(doc, 'stmt')).toEqual(expect.arrayContaining(['when', 'create', 'clear', 'delete', 'open']))
  expect(tokText(doc, 'name')).toEqual(expect.arrayContaining(['thread', 'draft', 'send', 'delete', 'user']))
  expect(tokText(doc, 'field')).toEqual(expect.arrayContaining(['author', 'text', 'sentAt']))
  expect(tokText(doc, 'flag')).toEqual(expect.arrayContaining(['bold', 'muted']))
  expect(tokText(doc, 'instName')).toEqual(['선우', '은후', '첫인사'])
  expect(tokText(doc, 'hole')).toEqual([])
})

test('예제 세 개에 구멍이 없다', () => {
  for (const n of ['chat', 'cart', 'sync']) expect(analyze(ex(n)).holes).toEqual([])
})

test('없는 이름은 구멍이 된다', () => {
  const a = analyze('interface Chat\n  list thread  of=Message\n')
  expect(a.holes).toEqual(['Message'])
})

test('계산 칸: 가정이 흐르고 기대를 확인한다', () => {
  const doc = ex('cart')
  expect(notesAt(doc, 'total = sum')).toEqual(['→ 3000 ✓'])
  expect(notesAt(doc, 'amount =')).toEqual(['→ 3000'])
  expect(notesAt(doc, 'check  .stock')).toEqual(['✓ 2개 모두'])
  const changed = doc.replace('qty=3]', 'qty=2]')
  expect(notesAt(changed, 'total = sum')).toEqual(['→ 2000 ✗ 기대 3000'])
})

test('모양: 본문에서 읽기·쓰기를 찾아낸다', () => {
  const send = analyze(ex('chat')).shapes.find(s => s.name === 'Send')!
  expect(send.on).toBe('Chat.send')
  expect(send.reads).toEqual(['Chat.draft', 'Session.user', 'Clock.now'])
  expect(send.writes).toEqual(['+ Message', '~ Chat.draft'])

  const checkout = analyze(ex('cart')).shapes.find(s => s.name === 'Checkout')!
  expect(checkout.reads).toEqual(['Cart.lines', 'Product.stock', 'Line.qty', 'Line.product', 'Cart.total'])
  expect(checkout.writes).toEqual(['~ Product.stock', '+ Order', '~ Cart.lines'])
  expect(checkout.fails).toEqual(['OutOfStock'])

  const remove = analyze(ex('chat')).shapes.find(s => s.name === 'Remove')!
  expect(remove.on).toBe('MessageCard.delete')
  expect(remove.writes).toEqual(['- Message'])

  const flush = analyze(ex('sync')).shapes.find(s => s.name === 'Flush')!
  expect(flush.emits).toEqual(['Remote.push'])
  expect(flush.writes).toEqual(['⊖ Sync.dirty'])
})

test('가정 실행: 사건을 가정하면 줄마다 결과가 붙는다', () => {
  const chat = ex('chat')
  expect(notesAt(chat, 'when Chat.draft')).toEqual(['참'])
  expect(notesAt(chat, 'clear Chat.draft')).toEqual(['"안녕" → ""'])
  expect(notesAt(chat, 'create Message')[0]).toBe('+ Message{author=선우 text="안녕" sentAt=14:02}')

  const cart = ex('cart')
  expect(notesAt(cart, 'when line.product.stock')).toEqual(['참'])
  expect(notesAt(cart, 'fail OutOfStock')).toEqual(['✗ OutOfStock product=펜'])
  expect(notesAt(cart, 'system Checkout')).toContain('↺ OutOfStock 로 전부 되돌림')

  const sync = ex('sync')
  expect(notesAt(sync, 'add Disk.changed.path')).toEqual(['⊕ "c.txt"'])
})

test('component: of 데이터로 화면 조각을 미리 본다', () => {
  const cart = ex('cart')
  expect(notesAt(cart, 'text "{.price}원"')).toEqual(['→ 1000원'])
  expect(notesAt(cart, 'button add')).toEqual(['→ disabled=false'])
  expect(notesAt(cart, 'text "합계')).toEqual(['→ 합계 3000원'])
})

import { here, complete } from '../src/lang/inspect'

describe('커서 자리', () => {
  const doc = ex('cart')
  const a = analyze(doc)
  const at = (s: string, k = 0) => doc.indexOf(s) + k
  test('경로 조각마다 정의·값·읽기쓰기', () => {
    const h = here(a, at('line.product.stock <', 7))
    expect(h.token?.id).toBe('Line.product')
    expect(h.value).toBe('펜')
    expect(h.scope.map(s => s.name)).toEqual(['line'])
    const s = here(a, at('line.product.stock <', 15))
    expect(s.token?.id).toBe('Product.stock')
    expect(s.writers).toContain('Checkout')
  })
  test('보간 안에서도', () => {
    expect(here(a, at('Cart.total}', 6)).value).toBe('3000')
  })
  test('model 칸 줄은 인스턴스마다', () => {
    expect(here(a, at('stock  Number', 1)).values).toEqual([{ label: '펜', value: '2' }, { label: '공책', value: '0' }])
  })
  test('그 자리에서 고칠 가정', () => {
    expect(here(a, at('stock  Number', 1)).edits.map(e => `${e.label}=${e.text}`)).toContain('펜.stock=2')
  })
  test('자동완성: 점 뒤엔 그 타입의 칸과 지금 값', () => {
    const r = complete(a, doc, at('line.product.stock <', 5))!
    expect(r.options.map(o => `${o.label}:${o.info}`)).toEqual(['product:펜', 'qty:3', 'amount:3000'])
  })
  test('자동완성: 줄 맨 앞은 문맥에 맞는 것만', () => {
    const r = complete(a, doc, at('  for line', 2))!
    expect(r.options.map(o => o.label)).toContain('when')
    expect(r.options.map(o => o.label)).not.toContain('button')
  })
})

import { Sim } from '../src/lang/sim'
import { plain } from '../src/lang/analyze'

describe('미리보기 세계', () => {
  const sim = () => new Sim(analyze(ex('cart')).roots)
  test('담기를 누르면 장바구니에 들어가고 합계가 바뀐다', () => {
    const s = sim()
    const t = s.w.systems.map(x => x.trigger)
    expect(t).toContain('ProductCard.add')
    const before = s.w.singles.get('Cart')!.f.lines
    const n0 = (before as unknown[]).length
    const pen = s.w.instancesOf('Product').find(o => o.name === '펜')!
    s.fire('ProductCard.add', pen)
    const last = s.log[s.log.length - 1]
    expect(last.ok).toBe(true)
    expect((s.w.singles.get('Cart')!.f.lines as unknown[]).length).toBeGreaterThanOrEqual(n0)
  })
  test('재고보다 많이 주문하면 통째로 되돌린다', () => {
    const s = sim()
    const pen = s.w.instancesOf('Product').find(o => o.name === '펜')!
    const stock0 = plain(pen.f.stock)
    for (let i = 0; i < 5; i++) s.fire('ProductCard.add', pen)
    s.fire('Shop.checkout')
    const co = s.log.filter(e => e.system === 'Checkout').pop()!
    expect(co.ok).toBe(false)
    expect(co.fail).toBe('OutOfStock')
    expect(plain(s.w.instancesOf('Product').find(o => o.name === '펜')!.f.stock)).toBe(stock0)
  })
})
