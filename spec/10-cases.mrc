// 값을 품은 고르기: model 안의 대문자 줄 = 경우 · match 로 갈라 쓴다
// 짧으면 괄호, 길면 블록 (model 이랑 같은 규칙)
model Shape
  Circle(r: Number)
  Rect
    w: Number
    h: Number
  Dot

c: Shape = Circle(r: 2)
area: Number = match c                ! 12
  Circle(r)      3 * r * r
  Rect(h, w)     w * h              // 순서 말고 이름으로 받는다
  Dot            0

// 함수도 = match 로
fn size(s: Shape) -> Number = match s
  Circle(r)      r * 2
  else           0

n: Number = size(Rect(w: 1, h: 2))    ! 0
d: Shape = Dot

// 글자 고르기도 같은 match
model Status = "pending" | "paid"
s: Status = "paid"
label: Text = match s                 ! "완료"
  "pending"      "대기"
  "paid"         "완료"

miss: Text = match s                  // 빈칸: 빠진 경우
  "paid"         "완료"
half: Number = match c                // 빈칸: 빠진 경우: Rect(w, h) · Dot
  Circle(r)      r
wrong: Shape = Circle(r: "a")         // 빈칸: Number 자리인데
many: Number = match c
  Circle(x)      x                    // 빈칸: 'x' 칸이 없어
  else           0
