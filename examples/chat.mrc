// 채팅: 가장 작은 Miracle 앱
use std.[dom.*, time.*]

model User
  name: Text        ? "선우"

model Message
  author: User
  text: Text        ? "안녕?"
  sentAt: Time      ? 14:00

me: User = User(name: "선우")
messages: Message[] = []     ? [Message(author: User(name: "은후"), text: "안녕?", sentAt: 14:00)]

mount "#app"
  Chat

fn Chat()
  draft: Text = ""     ? "안녕"

  main
    for message in messages.sortBy(.sentAt)
      MessageCard message=message
    form  onSubmit=send
      input  bind=draft  placeholder="메시지"
      button "보내기"  disabled=(draft == "")

  fn send()
    messages += Message(author: me, text: draft, sentAt: now())     ? 14:02
    draft = ""

fn MessageCard(message: Message)
  article
    strong message.author.name
    p message.text
    time message.sentAt  class="muted"
    button "삭제"  onClick=remove  if message.author == me

  fn remove()
    messages -= message
