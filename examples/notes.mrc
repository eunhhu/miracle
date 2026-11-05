// 메모: 파일 · 네트워크 · 기기 기능을 use 없이 이름으로 쓴다
use std.[dom.*]

model Note
  title: Text       ? "장보기"
  body: Text        ? "우유, 달걀"
  pinned: Bool = false

notes: Note[] = load("notes") ?? []     ? [Note(title: "장보기", body: "우유")]
draft: Text = ""

mount "#app"
  Notes

fn Notes()
  main
    input bind=draft  placeholder="새 메모"
    button "추가"  onClick=add  disabled=draft.isEmpty
    for note in notes.sortBy(.pinned).reverse()
      article
        strong note.title
        p note.body
        button "복사"  onClick=copy(note.body)

  fn add()
    notes += Note(title: draft.trim(), body: "")
    draft = ""
    save("notes", notes)
    notify("메모를 저장했어")

fn backup()
  write("./notes.json", notes)
  post("https://example.com/backup", notes)    ? none
