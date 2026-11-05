// 글자 다루기는 메서드로 (문법 추가 없음)
t: Text = "미라클"
cs: Text[] = t.chars                 ! ["미", "라", "클"]
c: Text? = t.at(1)                   ! "라"
s: Text = t.slice(0, 2)              ! "미라"
k: Int = "A".code()                  ! 65
i: Int? = t.indexOf("클")            ! 2
