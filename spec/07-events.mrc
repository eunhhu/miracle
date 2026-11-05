// 이벤트: on…= 에는 함수 이름이나 부르는 모양을 준다 (부르는 모양은 그때 부른다)
use std.[dom.*]

n: Int = 0

mount "#app"
  button "하나"  onClick=add
  button "다섯"  onClick=addMany(5)
  button "틀림"  onClick=n          // 빈칸: 함수를 줘

fn add()
  n += 1

fn addMany(k: Int)
  n += k
