// 반복은 for 하나: 목록 · 범위(..< 끝 빼고 · ..= 끝까지) · 번호 · 조건
xs: Text[] = ["a", "b", "c"]

fn f() -> Int
  total: Int = 0
  for i in 0..<3                     // 3 빼고: 0 1 2
    total += i
  for x, i in xs
    total += i
  pos: Int = 0
  for pos < 5
    pos += 1
  total + pos

r: Int = f()                         ! 11
upto: Int[] = 1..=3                  ! [1, 2, 3]
vague: Int[] = 0..3                  // 빈칸: 끝을 넣는지
ages: [Text: Int] = ["a": 1, "b": 2]

fn sum2() -> Int
  out: Int = 0
  for k, v in ages
    out += v
  out

s: Int = sum2()                      ! 3

fn g()
  for x in 5                         // 빈칸: for 는 목록을 돌아
    log x
