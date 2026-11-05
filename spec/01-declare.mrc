// 선언과 바꾸기: `이름: 타입 = 값` 은 만든다, `이름 = 값` 은 바꾼다
count: Int = 1          ! 1
name: Text = "펜"        ! "펜"
price: Number = 1.5     ! 1.5
ok: Bool = true         ! true

fn bump()
  count = count + 1
  count += 1

bad: Int = "abc"        // 빈칸: Int 자리인데
