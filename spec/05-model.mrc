// model: 칸 · 계산 칸 · check · 만들기
model Line
  price: Number
  qty: Int
  amount = .price * .qty
  check .qty > 0

l: Line = Line(price: 1000, qty: 3)
a: Number = l.amount                ! 3000
m: Line = Line(price: 1000)         // 빈칸: qty
o: Number = l.amout                 // 빈칸: amount?
