// 함수 결과: 마지막 줄이 결과 (return 없음)
model Line
  price: Number
  qty: Int

fn price(l: Line) -> Number
  base: Number = l.price * l.qty
  base * 0.9

p: Number = price(Line(price: 1000, qty: 2))    ! 1800

fn grade(n: Int) -> Text
  if n > 90
    "A"
  else
    "B"

g: Text = grade(95)                  ! "A"

// -> 를 안 적어도 마지막 줄 값이 결과
fn twice(n: Int)
  n * 2

t: Int = twice(4)                    ! 8

fn broken(n: Int) -> Text
  m: Int = n + 1                     // 빈칸: 마지막 줄이 결과야
fn wrongType(n: Int) -> Text
  n + 1                              // 빈칸: Text 자리인데
