# Miracle 명세 초안

> 상태: 초안 v0.2. 문장마다 붙은 태그로 결정 상태를 표시한다.
> **[확정]** 선우가 정한 방향. **[제안]** 검토 중인 안. **[열림]** 아직 답이 없는 질문.
> 예제는 [`examples/`](examples), 에디터는 [`docs/EDITOR.md`](docs/EDITOR.md).

---

## 규칙 카드 [확정]

이 일곱 줄이면 예제를 전부 읽을 수 있다.

1. **한 줄에 하나.** 들여쓰면 그 안에 든 것.
2. **`model`** 은 있는 것. `=` 이 붙으면 계산 칸.
3. **`interface`** 는 바깥과 닿는 곳.
4. **`system`** 은 바뀌는 곳. 값을 바꾸는 줄은 system 안에만 온다.
5. **`component`** 는 묶음. 아무 줄이나 묶어 이름 붙인다.
6. **`?`** 는 가정. 에디터에서만 꽂힌다.
7. **`app`** 은 시작점.

아래는 이 일곱 줄의 자세한 풀이다.

---

## 1. 줄

### 1.1 한 줄 = 하나 [확정]

```
종류  이름?  주인공값?  속성*   ? 가정   ! 기대
```

```miracle
button send  "보내기"  disabled=(count(Cart.lines) == 0)
│      │     │         └ 속성: key=값, 또는 값 없는 플래그(bold, muted)
│      │     └ 주인공값: 이름 없이 쓰는 값. 줄마다 최대 하나
│      └ 이름: 이 줄이 만드는 필드·포트·선언의 이름
└ 종류: 줄 맨 앞. 왼쪽 끝만 훑으면 구조가 보인다
```

- 들여쓰기가 중첩이다. 공백 두 칸, 탭 금지, 닫는 기호 없음.
- 속성 값에 연산이 들어가면 괄호로 감싼다: `visible=(.author == Session.user)`
- 줄 끝의 `? …` 는 가정(§6), `! …` 는 기대(§6.3)다.
- 주석은 `//` 부터 줄 끝까지.
- 선언 이름은 대문자, 필드·포트는 소문자로 시작한다. 한글 식별자를 쓸 수 있다. [제안]

### 1.2 문법 [제안]

```ebnf
file     = { line } ;
line     = indent node [ assume ] [ expect ] [ comment ] newline | blank ;
indent   = { "  " } ;
node     = kind [ name ] [ primary ] { attr } ;
attr     = ident "=" atom | ident ;
atom     = literal | path | list | set | "(" expr ")" ;
path     = "." [ ident { "." ident } ] | ident { "." ident } ;
assume   = "?" [ text ] ;
expect   = "!" text ;
literal  = number [ unit ] | string | bytes | time | "true" | "false" ;
string   = '"' { char | "{" expr "}" } '"' ;
```

이름 슬롯이 있는지는 종류가 정한다. `button send` 의 `send` 는 이름, `text .name` 의 `.name` 은 주인공값이다. 에디터는 둘을 다른 색으로 칠한다. [제안]

---

## 2. model: 있는 것

```miracle
model Line
  product  Product                  // 값 칸: 직접 넣는 값. system 이 바꾼다
  qty      Number
  amount = .product.price * .qty    // 계산 칸: 늘 자동 계산. 아무도 직접 못 바꾼다
  check  .qty > 0                   // 불변조건: 깨지면 트랜잭션이 통째로 실패
```

- **`=` 의 의미는 엑셀과 같다.** 값을 직접 입력한 칸과 `=` 로 시작하는 수식 칸. [확정]
- model 에는 로직이 없다. 값 칸, 계산 칸, 불변조건만 있다. [확정]
- `single` 플래그를 붙이면 하나뿐인 model 이다. 인스턴스 없이 `Cart.lines` 처럼 바로 쓴다. [제안]
- 인스턴스는 언어가 정체성을 준다. `id` 를 쓰지 않는다. [제안]
- 식 안에서 model 이름만 쓰면 그 model 의 전체 인스턴스다 (`of=Message`). [제안]

### 2.1 타입 [제안]

```
Text  Number  Bool  Time  Duration  Length  Color  Path  Bytes
List<T>  Set<T>  Map<K, V>  T?     model 이름 = 그 model 의 참조
```

단위가 타입이다. `5s` 는 Duration, `23px` 는 Length.

---

## 3. interface: 바깥과 닿는 곳

사람, 파일, 네트워크, 시계 모두 같은 문법이다. 화면 배치가 아니라 주고받는 계약이다. [확정]

### 3.1 방향은 종류가 정한다 [제안]

`in` / `out` 을 쓰지 않는다. 에디터가 방향을 투영해서 보여준다.

```
들어오는 값      input  value  read
들어오는 사건    button  watch  route(POST·PUT·DELETE)
나가는 값        list  text  time  notice  route(GET)
나가는 사건      call
묶음             screen  card  row  stack
```

화면의 버튼과 HTTP POST 는 같은 종류의 포트다. 읽기 전용 경로(`route GET`)는 `list` 와 같은 자리에 놓인다.

### 3.2 상태 [제안]

- 들어오는 값 포트(`input draft`)는 바깥이 쓰고, system 도 쓸 수 있다 (`clear Chat.draft`).
- 나가는 값 포트는 `of=` 나 주인공값으로 **계산**되거나(`list thread  of=Message`), 값 없이 선언해 system 이 쓰는 **슬롯**이 된다(`notice error`).

### 3.3 바깥 값도 interface 다 [제안]

시간, 현재 사용자, 난수에 암묵적인 전역은 없다. `Clock` 과 `Random` 은 표준 interface 이고, `Session` 처럼 앱마다 다른 것은 앱이 선언한다.

---

## 4. system: 바뀌는 곳

```miracle
system Send  on Chat.send
  when Chat.draft != ""
    create Message  author=Session.user  text=Chat.draft  sentAt=Clock.now
    clear Chat.draft
```

**값을 바꾸는 줄은 system 안에만 온다.** 이 규칙 하나 때문에 누가 무엇을 바꾸는지가 늘 모양에 드러난다. [확정]

### 4.1 트리거 [제안]

```
on Chat.send                    들어오는 사건
on delete                       같은 component 안의 사건
on Clock.every 5s               시간
on Message created|changed|deleted
on Cart.lines changed
on Checkout.fail OutOfStock     다른 system 의 실패
on Remote.push.fail             바깥 호출의 실패
on start                        app 이 열릴 때 (app 안에서만)
```

### 4.2 문장 [제안]

```
let 이름 = 식            when 식 / else          for 이름 in 식
set 경로 = 식            clear 경로              delete 식
create Model k=v…        add 값 to 경로          remove 값 from 경로
emit 포트 k=v…           fail 이름 k=v…          Component k=v…   (묶음 펼치기)
```

### 4.3 실행 의미 [제안]

- **사건 하나 = 트랜잭션 하나.** 시작 시점을 읽고, 쓰기는 끝에서 한꺼번에 반영한다. 본문 안의 줄 순서 때문에 결과가 달라지지 않는다.
- 한 트랜잭션에서 같은 칸을 두 번 `set` 하면 에러다. `add` / `remove` 는 겹쳐도 된다.
- `emit` 은 커밋된 뒤에 나간다. 롤백되면 나가지 않는다.
- 커밋으로 생긴 변화가 다른 system 을 부를 수 있다. 서로 부르는 고리가 생기면 에러다.

### 4.4 실패 [제안]

- `fail 이름` 은 트랜잭션을 통째로 되돌리고, 실패를 사건으로 내보낸다.
- 불변조건(`check`) 위반은 `fail Invalid` 다.
- 실패를 받는 쪽도 그냥 system 이다: `on Checkout.fail OutOfStock`
- 바깥 호출의 실패는 나중에 도착하는 사건이다: `on Remote.push.fail`

---

## 5. component: 묶음

```miracle
component MessageCard  of=Message
  card
    text .author.name  bold
    text .text
    button delete  "삭제"
  system Remove  on delete
    delete .
```

- **아무 줄이나 담는다.** interface 줄, system, model, 문장 무엇이든. After Effects 의 컴포지션처럼. [확정]
- 쓰는 곳에서는 이름 한 줄이다. 담긴 줄의 종류가 쓸 수 있는 자리를 정한다. 화면 조각은 화면 안에, 문장 묶음은 system 안에 놓는다. [제안]
- `of=` 로 받은 데이터는 `.` 으로 읽는다. 다른 입력은 이름 붙은 속성으로 받는다 (`component Price  n=Number`). [제안]
- 안에서 생긴 사건은 바깥에서 `MessageCard.delete` 로, 안에서는 `delete` 로 부른다. [제안]
- 담긴 system 도 "값을 바꾸는 줄은 system 안에만" 규칙을 그대로 따른다. 묶음은 규칙을 바꾸지 않는다. [확정]
- `button`, `list`, `route` 같은 표준 종류도 component 다. 확장하는 방법은 하나뿐이다. [제안]

### 5.1 `.` 은 가장 가까운 주어 [제안]

- model 안에서는 그 인스턴스, component 안에서는 `of=` 데이터.
- `where (…)`, `find (…)` 괄호 안에서는 각 원소.
- 바깥 주어가 필요하면 `let p = .` 로 이름을 붙인다.

---

## 6. `?`: 가정

### 6.1 무엇인가 [확정]

협업할 때 주석에 쓰던 `// ex) x = 5` 를 언어가 실제로 돌린다. 가정은 사람이 적고, 결과는 에디터가 적는다.

```
? 값    가정. 저장된다. 에디터에서만 꽂히고 배포에는 절대 영향이 없다
→ 값    결과. 저장되지 않는다. 에디터가 회색으로 그린다
! 값    기대. 저장된다. 실제 결과와 다르면 그 줄이 빨개진다
```

### 6.2 어디에 쓰나 [제안]

```miracle
model Product
  ? 펜  name="펜"  price=1000  stock=2        // 줄 맨 앞: 가정한 인스턴스. 이름이 붙는다

model Cart  single
  lines  List<Line>   ? [Line product=펜 qty=3]   // 줄 끝: 이 줄이 선언한 값의 가정

input draft  placeholder="메시지"   ? "안녕"     // 포트 값의 가정

system Checkout  on Shop.checkout   ?           // 사건 줄: 이 사건이 일어났다고 치자
system Mark  on Disk.changed   ? path="c.txt"   //   실린 값이 있으면 같이 적는다

  create Message  …  sentAt=Clock.now   ? Clock.now=14:02   // 선언 안 한 바깥 값
```

- 가정은 **값이 생기는 자리에 한 번만** 쓴다. 그 값을 읽는 모든 줄에 결과가 흐른다.
- `? "안녕" | ""` 처럼 대안을 적으면 에디터에서 토글로 바꿔 본다.

### 6.3 기대 [제안]

```miracle
  total = sum(.lines.amount)   ! 3000
```

### 6.4 sample: 이름 붙은 시나리오 [제안]

여러 값을 조합한 회귀 시나리오는 파일 아래 `sample` 로 둔다. 꽂으면 인라인 가정을 덮어쓴다.

```miracle
sample Checkout "주문하면 재고가 줄고 장바구니가 빈다"
  given Cart.lines=[Line product=펜 qty=2]
  expect 펜.stock=0
  expect + Order  total=2000
```

`expect` 형태: `+ Model k=v…` 생성, `경로=값` 상태, `emit …` 나간 사건, `fail 이름` 실패, `nothing` 변화 없음.

---

## 7. app: 시작점

```miracle
app 가게
  open Shop
  on start
    …                                // 필요하면 열릴 때 할 일
```

- `app` 줄이 있는 파일이 시작점이다. `open` 한 interface 만 살아 있다. [제안]
- 위에서부터 차례로 실행되는 `main` 은 없다. Miracle 은 사건을 기다린다. [확정]
- 화면은 처음 나온 `screen` 부터 보인다. [제안]

---

## 8. 늘 돌아간다 [확정]

컴파일과 실행을 나누지 않는다. 달라지는 것은 interface 에 무엇이 꽂혀 있느냐뿐이다.

```
에디터   가정(?)과 sample 이 꽂힌다. 디스크·네트워크는 실제로 건드리지 않는다
배포     같은 코드에 진짜 바깥이 꽂힌다
```

"빌드 실패"는 없다. 그 줄이 그 자리에서 빨개진다.

**모양은 입력 없이 정해진다.** 어떤 값이 들어와도 노드와 선은 그대로다. 메타프로그래밍도 같은 언어, 같은 실행기로 돌되 이 선을 넘지 않는다. 문법은 [열림]. [제안]

---

## 9. 모양 [확정]

system 본문에서 추론한다. 사람은 적지 않는다.

```
on      트리거
reads   읽은 칸·포트·바깥 값
writes  + 생성   ~ 변경   - 삭제   ⊕ 추가   ⊖ 제거
emits   나간 사건
fails   일어날 수 있는 실패
```

```
Checkout  on      Shop.checkout
          reads   Cart.lines · Cart.total · Product.stock
          writes  ~ Product.stock   + Order   ~ Cart.lines
          fails   OutOfStock
```

- 단위는 칸이다. model 통째로 뭉개지 않는다. 원소 단위까지 못 가면 묶음 단위로 올린다. [제안]
- component 안의 모양은 쓰는 곳으로 합쳐 올라간다. [제안]
- 변경은 줄이 아니라 모양으로 요약한다: `Checkout 이 이제 Coupon.rate 도 읽는다` [제안]

---

## 10. 모듈 [제안]

- 파일이 모듈이다. 최상위 선언은 기본 공개.
- `use cart` 로 가져온다. 에디터가 고친다.

---

## 11. 진단 [제안]

```
E-HOLE        없는 이름. 구멍으로 남고 실행은 계속된다
E-TYPE        타입 불일치
E-WRITE       system 밖에서 값을 바꿈
E-DOUBLE-SET  한 트랜잭션에서 같은 칸을 두 번 set
E-CYCLE       system 끼리 서로 부르는 고리
E-RACE        같은 사건의 두 system 이 같은 칸을 set
E-CHECK       불변조건 위반
E-EXPECT      ! 또는 expect 와 실제가 다름
W-UNTESTED    가정도 sample 도 닿지 않은 system
```

---

## 12. 열린 질문

- 이름 슬롯 유무를 종류가 정하는 방식이 충분히 읽히나?
- 스타일(크기·색·배치)을 interface 와 분리된 층으로 둘 때의 문법
- 모양을 그대로 권한 선언으로 쓸 수 있나?
- 읽기·쓰기가 겹치지 않는 system 의 병렬 실행 (성능 가설)
- 여러 인스턴스를 가정할 때 필드별 `?` 와 인스턴스 `?` 의 관계
- 재사용 계산(매개변수 있는 순수 식)을 component 의 `=` 줄로 충분히 덮을 수 있나?
- 메타프로그래밍 문법
