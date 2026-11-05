// 제네릭: 받는 자리가 결과 타입을 정한다
model U
  name: Text

users: U[] = [U(name: "a"), U(name: "b")]
found: U? = users.find(.name == "b")
names: Text[] = users.map(.name)        ! ["a", "b"]
