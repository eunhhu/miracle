# Miracle 기본 문법 (초안 3)

> 바깥으로 나가는 것과 값이 바뀌는 곳은 반드시 적는다. 같은 걸 두 번 적는 것만 뺀다.

도메인(http, ui …)은 전부 std 함수다. 언어가 아는 것은 아래뿐이다.
예제: [`examples/users/`](../examples/users/) — `user.mrc`(공유 모델) · `server.mrc`(서버) · `client.mrc`(웹)

## 규칙 카드

1. **한 줄에 하나. 들여쓰면 윗줄의 몸통.** 몸통의 값은 마지막 줄의 값.
2. **타입과 컴포넌트는 대문자, 값과 함수는 소문자.** 태그 자리에 소문자(`li`, `form`)가 오면 std 부품, 대문자(`UserRow`)면 내 컴포넌트.
3. **`이름: 타입 = 값` 은 선언, `이름 = 값` 은 바꾸기.** 어디서나 같다. 콜론이 있으면 새 이름.
4. **바뀌는지는 적지 않는다.** 어딘가에서 바꾸면 ✎, 아니면 🔒. 에디터가 이름마다 바꾸는 곳을 띄운다.
5. **`on…=` 은 이벤트, `bind=` 는 양방향.** 바깥과 닿는 곳은 이것뿐.
6. **부르기는 `f(x, key=v)`, 줄 맨 앞이면 괄호 없이 `f x key=v`.** 들여쓴 몸통은 마지막 인자(자식). 데이터 레코드는 `:` — `User(name: "선우")`.
7. **함수 끝 `catch` 는 실패했을 때.** 실패하면 그 함수의 바꾸기가 전부 되돌아간다.
8. **`|>` 는 왼쪽 값을 오른쪽에 넘긴다.** `T?` 는 없을 수 있음, `??` 기본값.
9. **줄 끝 `? 값` 은 예시, `! 값` 은 기대.** 예시가 있으면 그 자리에서 돈다.

---

## 값과 타입

```
3   3.5   1_000   5s   12px           Number
"합계 {total}원"                         Text
true  false   none
[1, 2]                                  List      타입: T[]
(name: "선우", cost: 0)                  Record    타입: (name: Text, cost: Number)
                                                  없을 수 있음: T?   이 중 하나: "a" | "b"
```

```miracle
model User
  name  Text    ? "선우"
  cost  Number  ? 0
  check .cost >= 0            // 깨지면 그 바꾸기가 통째로 취소
  total = .cost * 1.1         // 계산 칸. 늘 자동, 못 바꿈
```

`.` 은 지금 다루는 그 하나. model 안에선 그 인스턴스, `users.filter(.cost > 0)` 에선 각 원소.

## 이름과 바꾸기

```miracle
users: User[] = []            // 선언
limit: Number = 10            // 바꾸는 곳이 없으니 🔒

fn add(user: User)            // 인자도 선언
  users += user               // 바꾸기
```

## 함수와 컴포넌트

```miracle
fn UserRow(user: User)                // 몸통이 화면이면 컴포넌트. 그 안에선 못 바꾼다
  li
    strong user.name

fn AddUser()
  draft: User = User(name: "", cost: 0)   // 컴포넌트 안 선언 = 그 컴포넌트의 상태
  form  onSubmit=add
    input  bind=draft.name

  fn add()                            // 안쪽 함수는 바깥 상태를 본다
    users += draft
  catch
    error = "추가 못 했어"
```

파일 맨 위 선언은 앱 전체 상태, 컴포넌트 안 선언은 그 컴포넌트의 상태다.

## 서버와 클라이언트

서버와 클라이언트는 다른 파일, 다른 std 다. 같이 쓰는 건 모델뿐이다.

```
users/
  user.mrc       model User          ← 둘 다 use
  server.mrc     use std.[http.*]    serve · route · response
  client.mrc     use std.[dom.*, fetch.*]   mount · div … · get · post
```

```miracle
// server.mrc
route POST "/create"  body: User          // 머리의 타입 = "이 모양이면"
  users += body
  response 201 body
else
  response 422 "모양이 달라"
```

```miracle
// client.mrc
users: User[] = get "/api/user/list"      // 처음 값을 서버에서
user: User = post "/create" body=draft    // 실패하면 catch
```

`http` 는 받는 쪽(서버), `fetch` 는 보내는 쪽(클라이언트). 클라이언트에 서버 코드가 섞일 수 없다.
응답은 늘 `response` 줄로 적는다. 숨은 응답은 없다.

## 화면

UI 는 플랫폼별 std 다. 웹은 `dom`, 플랫폼 공통은 `ui`. 모양은 같다.

```miracle
use std.[dom.*]

mount "#app"
  App

fn App()
  main
    h1 "사용자"
    ul
      for user in users
        UserRow user=user
  p error  class="error"  if error      // 줄 끝 if: 조건일 때만 있다
```

## 갈래와 반복

```miracle
if cart.count > 0
  …
else
  …

match status
  "draft" -> "작성 중"
  "sent"  -> "보냄"

for u in users            // 머리에서 u 가 생긴다
  …
```

## 실패

```miracle
fail "재고 부족"            // 동작을 멈추고 그 동작의 바꾸기를 전부 되돌린다
```

## 모듈

**파일 = 모듈, 폴더 = 묶음. `export` 는 없다.**

- 파일 맨 위에 선언된 이름은 밖에서 보인다. 함수·컴포넌트 안쪽에 선언된 건 안 보인다. 위치가 곧 공개 범위다.
- 가져오기는 `use` 하나.

```miracle
use std.[dom.*, fetch.*]       // std
use ./user.*                   // 전부 바로 쓰기
use ./user.[User]              // 고른 것만
use ./store as store           // store.users 처럼 이름 붙여 쓰기
use ../lib/package/main.*
```

- 모듈 맨 위의 상태(`users: User[] = …`)는 그 모듈 하나에 하나다. 여러 파일이 `use` 하면 같은 값을 본다. 따로 스토어 라이브러리가 필요 없다.
- 컴포넌트 안의 상태는 그 컴포넌트가 그려질 때마다 하나씩이다.

### 그 자리에서 묶기

쪼개려고 파일을 먼저 만들지 않는다. 쓰던 자리에서 묶는다.

```miracle
fn App()
  ul
    for user in users
      li                              // ← 이 블록을 골라 묶기 (⌘G) → 이름: UserRow
        strong user.name
        span "{user.cost}원"
```

```miracle
fn App()
  ul
    for user in users
      UserRow user=user               // ⊞ 그 자리에서 펼쳐 보기 · 고치기

fn UserRow(user: User)                // 인자는 블록이 밖에서 쓰던 이름으로 자동
  li
    strong user.name
    span "{user.cost}원"
```

- 인자는 블록 안에서 쓰지만 밖에서 선언된 이름에서 추론한다. React 처럼 props 를 손으로 끌고 다니지 않는다.
- 블록이 밖의 상태를 바꾸면 그 상태는 `bind=` 인자가 된다.
- 묶은 건 같은 파일에 그대로 둬도 된다. 다른 파일로 옮기면 쓰던 쪽의 `use` 는 에디터가 붙인다.
- 반대로 `⊞` 로 펼치면 다시 그 자리 코드가 된다.

## 주석

```miracle
// 줄 끝까지
```

---

## 열린 질문

- 동작이 다른 동작을 부를 때 되돌림 범위
- `get` 이 기다리는 동안 / 실패했을 때 화면에 보이는 상태
- `dom` 과 `ui` 가 공유하는 부분
- 패키지 버전·배포 (`use ../lib/…` 다음 단계)
