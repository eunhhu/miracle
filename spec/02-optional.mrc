// 없을 수도 있는 값: T? · ?. · ?? · if 로 확인하면 좁혀진다
model P
  name: Text

ps: P[] = [P(name: "펜")]
first: P? = ps.first
n1: Text = first?.name ?? ""      ! "펜"
n2: Text = first.name             // 빈칸: 없을 수도

fn show()
  if first
    log first.name
