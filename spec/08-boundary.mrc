// 바깥(파일·네트워크·기기)은 use 없이 이름으로. 에디터 안에선 기록만 하고 ? 가 결과
fn sync()
  t: Text = read("./a.txt")             ? "hello"
  write("./b.txt", t.upper())
  r: Json = post("/api", t)
