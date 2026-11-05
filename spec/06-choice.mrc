// 고르기 타입: 정해진 값 중 하나
model Status = "pending" | "paid"

s: Status = "paid"
bad: Status = "nope"        // 빈칸: Status
