use std.[http.*]

model User
  name: Text        ? "선우"
  cost: Number      ? 0
  check .cost >= 0

users: User[] = []    ? [User(name: "선우", cost: 0)]

serve port=8080
  route GET "/"
    response 200  File("./index.html")  headers=(x-key: "hehe")

  route "/api/user"
    route GET "/list"  limit: Int?        ? limit=1
      response 200  users.take(limit ?? all)

    route POST "/create"  body: User          ? body=(name: "은후", cost: 3)
      users += body
      response 201 body
    else
      response 422 "Entity body validation failed"
