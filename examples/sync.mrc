// 파일 동기화: 화면이 없어도 같은 모양
use std.[fs.*, fetch.*, time.*]

dirty: Text[] = []     ? ["a.txt", "b.txt"]

watch "~/sync"  onChange=mark      ? "c.txt"
every 5s  onTick=flush

fn mark(path: Text)
  dirty += path

fn flush()
  for path in dirty
    send(path)

fn send(path: Text)
  post "https://sync.example/files"  body=read(path)     ? "ok"
  dirty -= path
catch reason
  log "{path}: 다음 번에 다시 ({reason})"
