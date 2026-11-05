// 맵: 타입 [K: V] · 값 ["a": 1] · 빈 맵 [:]
ages: [Text: Int] = ["a": 22, "b": 19]
n: Int = ages.count                  ! 2
e: [Text: Int] = [:]
a: Int? = ages.get("a")              ! 22
bad: [Text: Int] = ["x": "y"]        // 빈칸: Int
