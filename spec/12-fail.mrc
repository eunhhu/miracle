// 실패: fail 모델(…) · 실패하면 그 사건에서 바꾼 값은 되돌아간다 · 다르게 하고 싶을 때만 catch (match 처럼 갈래)
use std.[dom.*]

model OutOfStock(name: Text)
model Closed

stock: Int = 1
error: Text = ""

fn buy(n: Int)
  stock -= n
  if stock < 0
    fail OutOfStock(name: "펜")
catch OutOfStock(name)
  error = "{name} 재고가 부족해요"
catch Closed
  error = "닫혔어요"

// catch 가 없어도 된다: 실패하면 플랫폼이 되돌리고 보여준다
fn shut()
  fail Closed()

mount "#app"
  button "사기" onClick=buy(5)
  button "닫기" onClick=shut
  p error
