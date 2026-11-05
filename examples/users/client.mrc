use std.[dom.*, fetch.*]
use ./user.*

users: User[] = get "/api/user/list"     ? [User(name: "선우", cost: 0), User(name: "은후", cost: 3)]

mount "#app"
  App

fn App()
  main
    h1 "사용자"
    ul
      for user in users
        UserRow user=user
    AddUser

fn UserRow(user: User)
  li
    strong user.name
    span "{user.cost}원"  class="muted"

fn AddUser()
  draft: User = User(name: "", cost: 0)
  error: Text? = none

  form  onSubmit=add
    input  bind=draft.name  placeholder="이름"
    input  bind=draft.cost  type="number"  placeholder="비용"
    button "추가"  disabled=(draft.name == "")
  p error  class="error"  if error

  fn add()
    user: User = post "/api/user/create" body=draft     ? User(name: "은후", cost: 3)
    users += user
    draft = User(name: "", cost: 0)
    error = none
  catch
    error = "추가하지 못했어"
