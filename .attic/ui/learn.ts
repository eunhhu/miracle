// 쓰면서 배우기: 단어 설명, 자리마다 할 수 있는 것, 줄마다 남은 칸 안내

export type Place = 'top' | 'model' | 'iface' | 'ui' | 'system' | 'sample' | 'app'

/** 줄 번호(0부터)가 어떤 자리인지: 들여쓰기로 부모를 따라 올라간다 */
export function placeOf(lines: string[], no: number, indentOverride?: number): { place: Place; parent?: string; top?: string } {
  const ind = indentOverride ?? /^ */.exec(lines[no] ?? '')![0].length
  if (ind === 0) return { place: 'top' }
  let parent: string | undefined
  let top: string | undefined
  let want = ind
  for (let i = no - 1; i >= 0; i--) {
    const t = lines[i]
    if (!t.trim() || t.trim().startsWith('//')) continue
    const k = /^ */.exec(t)![0].length
    if (k < want) {
      const head = t.trim().split(/\s+/)[0]
      parent ??= head
      want = k
      if (k === 0) { top = head; break }
    }
  }
  const inSystem = (() => {
    // 가까운 조상 중 system 이 있으면 system 본문
    let w = ind
    for (let i = no - 1; i >= 0; i--) {
      const t = lines[i]
      if (!t.trim()) continue
      const k = /^ */.exec(t)![0].length
      if (k < w) { if (t.trim().startsWith('system ')) return true; w = k; if (k === 0) break }
    }
    return false
  })()
  if (inSystem) return { place: 'system', parent, top }
  switch (top) {
    case 'model': return { place: 'model', parent, top }
    case 'interface': return { place: parent === 'interface' ? 'iface' : 'ui', parent, top }
    case 'component': return { place: 'ui', parent, top }
    case 'sample': return { place: 'sample', parent, top }
    case 'app': return { place: 'app', parent, top }
  }
  return { place: 'ui', parent, top }
}

// ── 단어 설명 ───────────────────────────────────────────

export interface Word { what: string; ex?: string; more?: string }

export const WORDS: Record<string, Word> = {
  model: { what: '데이터의 모양. 칸과 타입만 적는다. 로직은 없다', ex: 'model Product\n  name   Text\n  price  Number' },
  interface: { what: '바깥과 닿는 계약. 화면, 장치, 서버가 여기 꽂힌다', ex: 'interface Shop\n  screen "상품"\n    button buy  "사기"' },
  system: { what: '사건이 오면 무엇이 바뀌는지. 값을 바꾸는 건 여기서만 된다', ex: 'system Buy  on Shop.buy\n  set Cart.count = Cart.count + 1' },
  component: { what: '줄 몇 개를 묶어 이름을 붙인 것. 어디든 이름만 쓰면 꽂힌다', ex: 'component ProductCard  of=Product\n  card\n    text .name' },
  sample: { what: '이름 붙은 시나리오. 값 몇 개를 넣고 결과를 고정해 둔다', ex: 'sample Checkout "재고가 준다"\n  given Cart.lines=[…]\n  expect 펜.stock=0' },
  app: { what: '어디서 시작하는지', ex: 'app 가게\n  open Shop' },
  open: { what: '이 앱에서 살아 있는 interface', ex: 'open Shop Session' },
  on: { what: '이 system 을 깨우는 사건', ex: 'system Send  on Chat.send' },
  check: { what: '모든 인스턴스가 늘 지켜야 하는 조건. 깨지면 그 사건은 통째로 되돌린다', ex: 'check  .stock >= 0' },
  single: { what: '세상에 딱 하나만 있는 model. 이름이 곧 값이다', ex: 'model Cart  single' },
  screen: { what: '화면 하나', ex: 'screen "장바구니"' },
  card: { what: '세로로 쌓는 카드 묶음' },
  row: { what: '가로로 늘어놓는 묶음' },
  stack: { what: '세로로 쌓는 묶음' },
  list: { what: '목록. of= 의 항목마다 안쪽 줄을 한 번씩 그린다. 안에서 . 은 그 항목', ex: 'list products  of=Product\n  ProductCard' },
  text: { what: '글자. "{식}" 으로 값을 끼워 넣는다', ex: 'text "합계 {Cart.total}원"  bold' },
  time: { what: '시간 표시' },
  button: { what: '누르면 사건이 생긴다. 이름이 곧 사건 이름', ex: 'button checkout  "주문하기"  disabled=(Cart.empty)' },
  input: { what: '사람이 치는 값. 이름으로 읽는다', ex: 'input draft  placeholder="메시지"' },
  notice: { what: '알림. system 이 값을 넣으면 보인다', ex: 'notice error' },
  value: { what: '바깥에서 들어오는 값', ex: 'value user  User' },
  watch: { what: '바깥에서 오는 사건 (파일 변경 같은)', ex: 'watch changed  "~/sync"' },
  read: { what: '바깥에서 읽어 오는 값' },
  call: { what: '바깥으로 보내는 요청', ex: 'call push  POST "https://…"' },
  when: { what: '조건. 참이면 안쪽 줄을 실행한다', ex: 'when .stock == 0\n  fail SoldOut' },
  else: { what: '바로 위 when 이 거짓이면 실행' },
  for: { what: '목록의 항목마다 안쪽 줄을 실행', ex: 'for line in Cart.lines' },
  let: { what: '값에 이름 붙이기. 이 블록 안에서만 보인다', ex: 'let p = .' },
  set: { what: '칸의 값을 바꾼다', ex: 'set line.qty = line.qty + 1' },
  clear: { what: '칸을 비운다 ("", [], {})', ex: 'clear Cart.lines' },
  create: { what: '새 인스턴스를 만든다', ex: 'create Order  total=Cart.total' },
  add: { what: '목록에 넣는다', ex: 'add Line product=p qty=1  to Cart.lines' },
  remove: { what: '목록에서 뺀다', ex: 'remove path from Sync.dirty' },
  delete: { what: '인스턴스를 지운다. 들어 있던 목록에서도 빠진다', ex: 'delete .' },
  emit: { what: '바깥으로 사건을 보낸다', ex: 'emit Remote.push  path=path' },
  fail: { what: '실패. 이 사건에서 바꾼 것을 전부 되돌리고, 이름 붙은 실패 사건이 생긴다', ex: 'fail OutOfStock  product=line.product' },
  given: { what: '시나리오에 넣을 값' },
  expect: { what: '시나리오 결과로 고정할 값' },
  of: { what: '무엇의 목록인지 / 이 component 의 . 이 무엇인지' },
  sort: { what: '정렬 기준 칸' },
  placeholder: { what: '비어 있을 때 보이는 안내 글자' },
  disabled: { what: '참이면 버튼이 눌리지 않는다' },
  visible: { what: '거짓이면 숨긴다' },
  bold: { what: '굵게' },
  muted: { what: '흐리게' },
  find: { what: '조건에 맞는 첫 항목', ex: 'Cart.lines find (.product == p)' },
  where: { what: '조건에 맞는 항목 전부', ex: 'Product where (.stock > 0)' },
  sum: { what: '합계', ex: 'sum(.lines.amount)' },
  count: { what: '개수', ex: 'count(Cart.lines)' },
  in: { what: 'for 이름 in 목록' }, to: { what: 'add 값 to 목록' }, from: { what: 'remove 값 from 목록' },
  and: { what: '그리고' }, or: { what: '또는' }, not: { what: '아니다' },
  '?': { what: '가정. 이 자리에 이 값이 들어왔다고 치고 에디터가 돌린다. 앱에는 안 들어간다', ex: 'qty  Number   ? 3' },
  '!': { what: '기대. 계산 결과가 이 값이 아니면 빨개진다', ex: 'total = sum(.lines.amount)   ! 3000' },
  '=': { what: '계산 칸. 엑셀 수식처럼 늘 다시 계산되고, 직접 바꿀 수 없다', ex: 'amount = .product.price * .qty' },
  '.': { what: '지금 보고 있는 그것. component 면 of= 의 항목, list 안이면 그 항목' },
  Text: { what: '글자' }, Number: { what: '숫자' }, Bool: { what: '참/거짓' }, Time: { what: '시각' },
  List: { what: '순서 있는 목록', ex: 'List<Line>' }, Set: { what: '겹치지 않는 모음', ex: 'Set<Path>' }, Path: { what: '파일 경로' }, Bytes: { what: '바이트' },
}

// ── 줄마다 남은 칸 ──────────────────────────────────────

/** 줄 머리 단어 → 뒤에 올 칸들 */
export const SLOTS: Record<string, string[]> = {
  model: ['이름', 'single?'],
  interface: ['이름'],
  component: ['이름', 'of=모델'],
  system: ['이름', 'on 사건', '? 가정'],
  sample: ['system', '"설명"'],
  app: ['이름'],
  open: ['interface…'],
  screen: ['"제목"'],
  list: ['이름', 'of=목록', 'sort=칸'],
  text: ['값 또는 "글자 {식}"', 'bold · muted'],
  button: ['이름', '"글자"', 'disabled=(조건)'],
  input: ['이름', 'placeholder="안내"', '? 가정'],
  notice: ['이름'],
  value: ['이름', '타입', '? 가정'],
  watch: ['이름', '"경로"'],
  call: ['이름', 'GET|POST', '"주소"'],
  check: ['조건'],
  when: ['조건'],
  for: ['이름', 'in', '목록'],
  let: ['이름', '=', '값'],
  set: ['대상', '=', '값'],
  clear: ['대상'],
  create: ['모델', '칸=값 …'],
  add: ['값', 'to', '목록'],
  remove: ['값', 'from', '목록'],
  delete: ['대상'],
  emit: ['사건', '칸=값 …'],
  fail: ['실패이름', '칸=값 …'],
  given: ['대상=값 …'],
  expect: ['대상=값 · nothing · emit …'],
}

/** 줄 끝에 흐리게 보여 줄 남은 칸 */
export function slotHint(text: string, place: Place): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  const words = t.split(/\s+/)
  const head = words[0]
  if (place === 'model' && words.length === 1 && /^[a-z]/.test(head) && !SLOTS[head]) return '타입   또는   = 계산식'
  const slots = SLOTS[head]
  if (!slots) return undefined
  // 이미 친 칸 수 (따옴표 안 공백은 하나로)
  const typed = (t.slice(head.length).match(/"[^"]*"?|\([^)]*\)?|\S+/g) ?? []).length
  const rest = slots.slice(typed)
  if (!rest.length) return undefined
  return rest.join('  ')
}

// ── 자리마다 할 수 있는 것 (/ 메뉴) ──────────────────────

export interface Action { label: string; word: string; snippet: string; what: string; ex?: string }

const A = (word: string, label: string, snippet: string): Action => ({ word, label, snippet, what: WORDS[word]?.what ?? '', ex: WORDS[word]?.ex })

export const ACTIONS: Record<Place, Action[]> = {
  top: [
    A('model', '데이터 모양 만들기', 'model ${이름}\n\t${칸}  ${Text}'),
    A('interface', '화면 · 바깥 계약 만들기', 'interface ${이름}\n\tscreen "${제목}"\n\t\t${}'),
    A('system', '사건이 오면 바꾸기', 'system ${이름}  on ${사건}\n\t${}'),
    A('component', '줄 묶음 만들기', 'component ${이름}  of=${모델}\n\tcard\n\t\ttext .${칸}'),
    A('sample', '시나리오 고정하기', 'sample ${system} "${설명}"\n\tgiven ${대상}=${값}\n\texpect ${결과}'),
  ],
  model: [
    A('Text', '칸 추가', '${이름}  ${Text}'),
    A('=', '계산 칸 추가', '${이름} = ${식}'),
    A('?', '예시 데이터 넣기', '? ${이름}  ${칸}=${값}'),
    A('check', '지켜야 할 조건', 'check  ${조건}'),
  ],
  iface: [
    A('screen', '화면', 'screen "${제목}"\n\t${}'),
    A('value', '들어오는 값', 'value ${이름}  ${타입}'),
    A('watch', '바깥 사건 받기', 'watch ${이름}  "${경로}"'),
    A('call', '바깥으로 요청', 'call ${이름}  POST "${주소}"'),
  ],
  ui: [
    A('text', '글자', 'text "${글자}"'),
    A('button', '버튼', 'button ${이름}  "${글자}"'),
    A('input', '입력 칸', 'input ${이름}  placeholder="${안내}"'),
    A('list', '목록', 'list ${이름}  of=${모델}\n\t${}'),
    A('card', '카드로 묶기', 'card\n\t${}'),
    A('row', '가로로 늘어놓기', 'row\n\t${}'),
    A('notice', '알림', 'notice ${이름}'),
    A('screen', '화면', 'screen "${제목}"\n\t${}'),
  ],
  system: [
    A('when', '조건이 맞을 때만', 'when ${조건}\n\t${}'),
    A('set', '값 바꾸기', 'set ${대상} = ${값}'),
    A('create', '새로 만들기', 'create ${모델}  ${칸}=${값}'),
    A('add', '목록에 넣기', 'add ${값} to ${목록}'),
    A('remove', '목록에서 빼기', 'remove ${값} from ${목록}'),
    A('clear', '비우기', 'clear ${대상}'),
    A('for', '하나씩 돌기', 'for ${이름} in ${목록}\n\t${}'),
    A('let', '이름 붙이기', 'let ${이름} = ${값}'),
    A('fail', '실패시키고 되돌리기', 'fail ${이름}'),
    A('delete', '지우기', 'delete ${대상}'),
    A('emit', '바깥으로 보내기', 'emit ${사건}'),
    A('else', '아니면', 'else\n\t${}'),
  ],
  sample: [
    A('given', '넣을 값', 'given ${대상}=${값}'),
    A('expect', '고정할 결과', 'expect ${대상}=${값}'),
  ],
  app: [A('open', '살릴 interface', 'open ${interface}')],
}

/** 빈 줄에 흐리게 보여 줄 안내 */
export function emptyHint(place: Place): string {
  if (place === 'model') return '칸이름  타입  ·  이름 = 계산식  ·  ? 예시데이터  ·  check 조건      / 를 누르면 전부'
  const words = ACTIONS[place].slice(0, 5).map(a => a.word).filter(w => /^[a-z]/.test(w))
  const lead: Record<Place, string> = {
    top: '여기에 새 블록', model: '칸이름  타입', iface: '화면이나 바깥 장치', ui: '보일 것', system: '바뀔 것', sample: '시나리오', app: '살릴 것',
  }
  return `${lead[place]} — ${words.join(' · ')}   / 를 누르면 전부`
}
