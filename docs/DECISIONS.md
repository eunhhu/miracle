# 언어 굳히기 — 결정 문서

> 0단계(언어 굳히기)의 정답지. 여기서 **확정**된 것은 `spec/*.mrc` 로 박고, Rust core 는 그 스펙을 통과하는 것을 목표로 한다.
> 상태: **확정** · **추천**(선우 OK 대기) · **열림**
> 기한 제안: 결정 2주 → 이후 2주 동안 문법 변경 없으면 Rust 포팅 시작.

---

## A. 이미 확정 — 바꾸지 않는다

| # | 규칙 | 스펙 |
|---|---|---|
| A1 | 한 줄에 하나, 들여쓰기 = 안에 든 것 (공백 2칸) | 전체 |
| A2 | 소문자 = 값·함수·기본 부품, 대문자 = 타입·컴포넌트 | 전체 |
| A3 | `이름: 타입 = 값` 은 만들기, `이름 = 값`·`+=`·`-=` 는 바꾸기 | `01-declare` |
| A4 | 처음 나온 이름에 `=` → 에디터가 `: 타입` 을 채움 | `09-infer` |
| A5 | 기본 타입 `Text Int Number Bool Time Duration Bytes Json` (Path·Url·Id 는 Text) | `01` |
| A6 | 타입 모양 `T[]` `T?` `[K: V]` `A \| B` `(A, B) -> R` | `02` `04` |
| A7 | 없음은 `none`, `?.` `??`, `if x` 로 확인하면 좁혀짐 | `02-optional` |
| A8 | 메서드는 타입에 붙는다. 값(칸)은 괄호 없이, 할 일은 괄호로 | `03-members` |
| A9 | `model` = 칸 · 계산 칸(`=`) · `check` | `05-model` |
| A10 | 이벤트 `on…=` 에는 함수 이름 또는 부르는 모양(그때 부름) | `07-events` |
| A11 | 바깥(io·net·native)은 `use` 없이 이름으로, 화면 부품(`dom`·`ui`)만 `use` | `08-boundary` |
| A12 | 파일 = 모듈, `export` 없음, `use ./파일.*` | `examples/users` |
| A13 | 줄 끝 `? 값` = 예시, `! 값` = 기대 | 전체 |
| A14 | 컴파일 타임/런타임 구분을 사용자에게 보이지 않는다 | — |

---

## B. 확정 (2026-11-06 선우 OK) — 구현·스펙 완료

- B1 제네릭 · B2 고르기 model · B3 match · B4 마지막 줄 결과 · B5 fail/catch 갈래/422 · B7 for · B8 맵 · B9 글자 메서드 · B10 정렬 · B11 고정 표시 · B12 공개 범위 → **확정**
- 스펙: `spec/10-cases` `11-result` `12-fail` `13-for` `14-map` `15-text`, 실행 테스트 `editor/test/lang.test.ts`
- 2차 다듬기: 갈래는 **이름으로** 받음(`Rect(h, w)` 순서 무관, 없는 칸은 빈칸) · 사건 실패는 플랫폼이 되돌리고 보여줌(catch 는 다르게 처리할 때만) · 경우도 model 처럼 「짧으면 괄호, 길면 블록」 · 범위는 `0..<3`(끝 빼고) / `1..=3`(끝까지), 맨 `..` 은 빈칸
- **남음:** 조건 반복 `for pos < n` 모양과 중간에 빠져나가기, B6 `all(…)` (std 에 `all` 이 이미 '전부' 값이라 이름 충돌 → 이름 다시 정하기), B3 `if x is Circle(r)` (`is` 키워드 추가 여부)

## B. 결정 내용

### B1. 제네릭 — **추천: 대문자 한 글자 = 타입 변수, 선언 없음**
```miracle
fn first(xs: T[]) -> T? = xs.first
```
`<T>` 같은 선언 문법을 늘리지 않는다. 제약(`T` 는 비교 가능해야 함 등)은 쓰임새에서 알아내고, 안 맞으면 부르는 자리에서 빈칸.
(이미 이렇게 구현됨 · `04-generic`)

### B2. 고르기 타입 — **추천: `model` 하나로 레코드·고르기·별칭 전부**
```miracle
model Status = "pending" | "paid"          // 값 고르기 (구현됨 · 06-choice)
model Price = Number                        // 별칭

model Shape                                 // 값을 품은 고르기: 대문자 줄 = 경우
  Circle(r: Number)
  Rect(w: Number, h: Number)
```
규칙 추가 없이 A2(대문자 = 타입)로 읽힌다: model 안의 소문자 줄은 칸, 대문자 줄은 경우.
**셀프호스팅에 필수** (문법 트리 = `model Expr` 의 경우들).

### B3. 갈라 쓰기 — **추천: `match` (이미 예약어), 갈래 = 줄**
```miracle
area: Number = match shape
  Circle(r)      3.14 * r * r
  Rect(w, h)     w * h
```
갈래는 `모양  값` 한 줄, 길면 들여써서 블록. 빠진 경우가 있으면 빈칸(에디터가 자동 고침으로 갈래를 채워줌), 나머지는 `else`.
`if` 로도 좁히기 가능: `if shape is Circle(r)` — **열림** (`is` 를 키워드로 늘릴지).

### B4. 함수 결과 — **추천: 마지막 줄이 결과, `return` 없음**
```miracle
fn price(l: Line) -> Number
  base: Number = l.product.price * l.qty
  base * 0.9
```
중간에 나가기는 `if … else` 구조나 `fail`. `return` 키워드 대신 에디터가 결과 줄에 `→` 표시.
**열림 포인트:** 파서처럼 이른 반환이 많은 코드에서 불편할 수 있음 → 셀프호스팅 전에 재평가.

### B5. 실패 — **추천: `fail 모델(…)` + 함수 `catch`, 실패한 함수의 바꾼 값은 되돌림**
```miracle
model OutOfStock(product: Product)            // 실패도 그냥 model (B2 의 한 줄 형태)

fn checkout()
  for line in cart
    if line.qty > line.product.stock
      fail OutOfStock(product: line.product)
  orders += Order(lines: cart)
catch OutOfStock(p)                            // catch 도 match 처럼 갈래
  error = "{p.name} 재고가 부족해요"
```
- `catch` 가 있는 함수 = 되돌림 단위 (트랜잭션). 실패하면 그 함수 안에서 바꾼 값이 전부 원래대로.
- 실패할 수 있는 바깥 호출(`read`·`get` …)을 이벤트 함수에서 `catch` 없이 쓰면 빈칸 + 자동 고침으로 `catch` 블록 생성.
- 서버: `body: User` 처럼 받는 모양이 안 맞으면 **플랫폼이 알아서 422**. 바꾸고 싶을 때만 `catch`. (지금 `route … else` 는 폐기)

### B6. 기다림(비동기) — **추천: 문법 없음**
`get`·`read` 는 그냥 값처럼 쓰고, 기다리는 동안은 에디터·런타임이 처리(화면은 그 부분만 "불러오는 중"). 동시에 하려면 `all(get(a), get(b))` std 함수. `async/await` 없음.

### B7. 반복 — **추천: `for` 하나**
```miracle
for item in items           // 목록
for i in 0..n               // 범위 (.. 연산자 추가)
for item, i in items        // 번호 같이
for pos < src.count         // 조건 반복 (while 대신)
```
**셀프호스팅에 필수** (lexer 는 조건 반복이 있어야 짜기 편함). `..`·조건 `for` 는 새 모양이라 OK 필요.

### B8. 맵 — **추천: 타입 `[K: V]`, 값 `["a": 1]`, 빈 맵 `[:]`**
레코드 `(name: "a")` 와 구분: 키가 이름이면 레코드, 값이면 맵.

### B9. 글자 다루기 — **추천: std 메서드로 (문법 추가 없음)**
`t.chars` `t.at(i)` `t.slice(a, b)` `t.code(i)` `t.startsWith(x)` `Text.join(xs, sep)`. 바이트는 `Bytes`. 셀프호스팅용 성능은 Rust core 에서.

### B10. 정렬·비교 — **추천: 숫자·글자·시간만 `<` 와 `.sort()`**
model 끼리 `==` 는 칸 값 비교(구조적). `<` 는 안 됨 → `sortBy(.칸)`. (`.sort()` 이번에 추가됨 · `03-members`)

### B11. 바꿀 수 있는 값 — **추천: `let/const` 없음, 다시 안 바꾸는 이름은 에디터가 "고정" 표시**
키워드 대신 추적 그래프의 네모(바꾸는 곳)가 없으면 고정. 최상위 값을 바꾸는 줄은 함수 안에서만.

### B12. 공개 범위 — **추천: 파일 안의 최상위는 다 보인다**
감추고 싶으면 함수 안에 넣는다. `_`·`private` 같은 규칙 안 늘림.

---

## C. 0단계 밖 (Rust 이후)

- 패키지·버전 (`use github.com/x/y@1`)
- 단위 타입(원·kg 등) — `Duration` 만 지금
- 동시성 모델 상세, 네이티브 런타임
- 성능 최적화

---

## 진행 방식

1. B 항목을 선우가 OK / 수정.
2. 확정되면 `spec/NN-이름.mrc` 로 추가 → `bun test` 가 정답지.
3. TS core 를 스펙에 맞춤 → 예제 앱 재작성으로 검증.
4. 2주간 문법 변경 없으면 Rust 포팅.

스펙 테스트 규칙 (`editor/test/spec.test.ts`):
- 줄 끝 `// 빈칸: 글자` → 그 줄에 그 글자를 담은 빈칸이 있어야 함
- 표시 없는 줄 → 빈칸이 없어야 함
- `! 값` → 실행 결과가 그 값이어야 함
