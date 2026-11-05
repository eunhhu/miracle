// std: 언어가 아니라 라이브러리.
//  - 화면 부품(dom · ui)은 "어디에 그리나" 를 정하는 것이라 파일 맨 위에 use 로 고른다.
//  - 나머지(http · net · io · time · native)는 그냥 쓴다. 내 이름이 있으면 내 것이 먼저.
//
// ty 는 타입 문법 그대로 적는다 (types.ts). 대문자 한 글자 = 쓰는 쪽에서 정해지는 타입.
//   users: User[] = get("/api/users")     → get 의 T 가 User[] 로 정해진다.

import { PRIMS } from './types'

export type StdKind = 'tag' | 'fn' | 'boundary' | 'source' | 'top' | 'value'
export type Platform = 'web' | 'server' | 'desktop' | 'mobile'
export interface StdItem {
  kind: StdKind
  doc: string
  /** 보기용 한 줄 예시 */
  sig?: string
  /** 타입 (types.ts 문법) */
  ty?: string
  /** 실패할 수 있다 → catch 로 받는다 */
  fails?: boolean
  /** 이 플랫폼에서만 */
  on?: Platform[]
}

const tags = (names: string, doc: string) =>
  Object.fromEntries(names.split(' ').map(n => [n, { kind: 'tag' as const, doc, ty: 'View' }]))

const SRV: Platform[] = ['server', 'desktop']

export const STD: Record<string, Record<string, StdItem>> = {
  dom: {
    ...tags('main div section article header footer nav aside h1 h2 h3 h4 p span strong em small ul ol li form label input textarea select option button a img time table tr td th hr br', 'HTML 요소'),
    mount: { kind: 'top', doc: '이 화면을 웹 페이지의 한 자리에 붙인다', sig: 'mount "#app"', ty: '(selector: Text) -> ()', on: ['web'] },
    title: { kind: 'fn', doc: '탭 제목을 바꾼다', sig: 'title("장바구니")', ty: '(text: Text) -> ()', on: ['web'] },
    location: { kind: 'value', doc: '지금 주소', sig: 'location.path', ty: '[Text: Text]', on: ['web'] },
    go: { kind: 'fn', doc: '다른 주소로 이동', sig: 'go("/cart")', ty: '(path: Text) -> ()', on: ['web'] },
  },
  ui: {
    ...tags('screen row col stack text input button list card notice image spacer', '플랫폼 공통 화면 부품'),
    app: { kind: 'top', doc: '앱의 첫 화면', sig: 'app', ty: '() -> ()' },
  },
  http: {
    serve: { kind: 'top', doc: '이 포트로 요청을 받는다', sig: 'serve port=8080', ty: '(port: Int) -> ()', on: SRV },
    route: { kind: 'fn', doc: '이 길·모양의 요청이 오면 몸통을 돈다. 모양이 안 맞으면 else', sig: 'route POST "/path"  body: T', on: SRV },
    request: { kind: 'value', doc: '지금 처리 중인 요청', sig: 'request.headers', ty: 'Request', on: SRV },
    response: { kind: 'fn', doc: '응답을 보내고 끝낸다', sig: 'response 201 값', ty: '(status: Int, body: Json?, headers: [Text: Text]?) -> ()', on: SRV },
    File: { kind: 'fn', doc: '파일을 응답 몸통으로', sig: 'File("./index.html")', ty: '(path: Text) -> File', on: SRV },
  },
  net: {
    get: { kind: 'boundary', doc: '받아 온다. 받는 자리의 타입대로 모양을 확인한다', sig: 'get "/api/users"', ty: '(url: Text, query: [Text: Text]?, headers: [Text: Text]?) -> T', fails: true },
    post: { kind: 'boundary', doc: '보낸다', sig: 'post "/api/users" body=user', ty: '(url: Text, body: Json?, headers: [Text: Text]?) -> T', fails: true },
    put: { kind: 'boundary', doc: '바꾼다', sig: 'put "/api/users/1" body=user', ty: '(url: Text, body: Json?, headers: [Text: Text]?) -> T', fails: true },
    del: { kind: 'boundary', doc: '지운다', sig: 'del "/api/users/1"', ty: '(url: Text, headers: [Text: Text]?) -> T', fails: true },
    socket: { kind: 'source', doc: '계속 열어 두고 받는다', sig: 'socket "wss://…"  onMessage=got', ty: '(url: Text, onMessage: (Json) -> ()) -> Socket', fails: true },
    send: { kind: 'boundary', doc: '열린 연결로 보낸다', sig: 'send(sock, msg)', ty: '(to: Socket, value: Json) -> ()', fails: true },
  },
  io: {
    read: { kind: 'boundary', doc: '파일을 글자로 읽는다', sig: 'read("./a.txt")', ty: '(path: Text) -> Text', fails: true, on: SRV },
    readBytes: { kind: 'boundary', doc: '파일을 바이트로 읽는다', sig: 'readBytes("./a.png")', ty: '(path: Text) -> Bytes', fails: true, on: SRV },
    write: { kind: 'boundary', doc: '파일에 쓴다 (덮어쓰기). 글자·바이트가 아니면 JSON 으로', sig: 'write("./a.txt", text)', ty: '(path: Text, value: Text | Bytes | Json) -> ()', fails: true, on: SRV },
    append: { kind: 'boundary', doc: '파일 끝에 붙인다', sig: 'append("./log.txt", line)', ty: '(path: Text, value: Text) -> ()', fails: true, on: SRV },
    list: { kind: 'boundary', doc: '폴더 안 이름들', sig: 'list("./photos")', ty: '(dir: Text) -> Text[]', fails: true, on: SRV },
    exists: { kind: 'boundary', doc: '있나', sig: 'exists("./a.txt")', ty: '(path: Text) -> Bool', on: SRV },
    remove: { kind: 'boundary', doc: '지운다', sig: 'remove("./a.txt")', ty: '(path: Text) -> ()', fails: true, on: SRV },
    watch: { kind: 'source', doc: '폴더가 바뀌면', sig: 'watch "~/dir"  onChange=f', ty: '(dir: Text, onChange: (Text) -> ()) -> ()', on: SRV },
  },
  time: {
    now: { kind: 'boundary', doc: '지금 시각. 에디터에선 줄 끝 ? 값', sig: 'now()', ty: '() -> Time' },
    every: { kind: 'source', doc: '정해진 간격마다', sig: 'every 5s  onTick=f', ty: '(interval: Duration, onTick: () -> ()) -> ()' },
    after: { kind: 'source', doc: '한 번, 이만큼 뒤에', sig: 'after 3s  onTick=f', ty: '(delay: Duration, onTick: () -> ()) -> ()' },
  },
  native: {
    platform: { kind: 'value', doc: '지금 도는 곳', sig: 'platform == "mac"', ty: '"web" | "server" | "mac" | "windows" | "linux" | "ios" | "android"' },
    env: { kind: 'boundary', doc: '환경 변수', sig: 'env("API_KEY")', ty: '(name: Text) -> Text?', on: SRV },
    open: { kind: 'fn', doc: '브라우저·앱으로 연다', sig: 'open("https://…")', ty: '(url: Text) -> ()' },
    notify: { kind: 'fn', doc: '알림을 띄운다', sig: 'notify("주문 완료")', ty: '(title: Text, body: Text?) -> ()' },
    copy: { kind: 'fn', doc: '클립보드에 넣는다', sig: 'copy(text)', ty: '(text: Text) -> ()' },
    paste: { kind: 'boundary', doc: '클립보드에서 꺼낸다', sig: 'paste()', ty: '() -> Text' },
    save: { kind: 'fn', doc: '이 기기에 저장 (껐다 켜도 남음)', sig: 'save("draft", draft)', ty: '(key: Text, value: Json) -> ()' },
    load: { kind: 'boundary', doc: '저장한 걸 꺼낸다. 받는 자리의 타입대로', sig: 'draft: Text? = load("draft")', ty: '(key: Text) -> T?' },
    run: { kind: 'boundary', doc: '프로그램을 실행하고 출력을 받는다', sig: 'run("git", ["status"])', ty: '(command: Text, args: Text[]?) -> Text', fails: true, on: SRV },
  },
}

/** 예전 이름 */
export const MODULE_ALIAS: Record<string, string> = { fetch: 'net', fs: 'io' }

/** use 없이 쓰는 모듈 (화면 부품만 use 로 고른다) */
export const AUTO_MODULES = ['http', 'net', 'io', 'time', 'native']

export const MODULE_DOC: Record<string, string> = {
  dom: '웹 화면 (HTML)', ui: '플랫폼 공통 화면', http: '서버: 요청 받기 · 응답', net: '바깥 서버와 주고받기',
  io: '파일', time: '시각 · 타이머', native: '기기 기능 (알림 · 클립보드 · 저장 · 실행)',
}

/** 늘 있는 것 */
export const BUILTIN: Record<string, StdItem> = {
  sum: { kind: 'fn', doc: '합', sig: 'sum(cart.amount)', ty: '(items: T[]) -> T' },
  min: { kind: 'fn', doc: '가장 작은 값', sig: 'min(prices)', ty: '(items: T[]) -> T?' },
  max: { kind: 'fn', doc: '가장 큰 값', sig: 'max(prices)', ty: '(items: T[]) -> T?' },
  log: { kind: 'fn', doc: '기록을 남긴다', sig: 'log "글"' },
  all: { kind: 'value', doc: '끝없음 (take(all))', sig: 'take(all)', ty: 'Int' },
}

export const BASE_TYPES = new Set<string>(PRIMS)

export function stdLookup(enabled: Map<string, StdItem>, name: string): StdItem | undefined {
  return enabled.get(name) ?? BUILTIN[name]
}

/** 처음부터 쓸 수 있는 std 이름 */
export function autoStd(): Map<string, StdItem> {
  const out = new Map<string, StdItem>()
  for (const m of AUTO_MODULES) for (const [k, v] of Object.entries(STD[m])) if (!out.has(k)) out.set(k, v)
  return out
}

/** use std.[dom.*, http.*] → 쓸 수 있는 이름 */
export function enableStd(items: string[] | '*'): Map<string, StdItem> {
  const out = new Map<string, StdItem>()
  const list = items === '*' ? Object.keys(STD).map(k => k + '.*') : items
  for (const it of list) {
    const [mod0, what] = it.split('.')
    const m = STD[MODULE_ALIAS[mod0] ?? mod0]
    if (!m) continue
    if (what === '*' || what === undefined) for (const [k, v] of Object.entries(m)) out.set(k, v)
    else if (m[what]) out.set(what, m[what])
  }
  return out
}

export function stdModuleOf(name: string): string | undefined {
  for (const [m, items] of Object.entries(STD)) if (items[name]) return m
}
