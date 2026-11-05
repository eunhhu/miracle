// 장바구니: 계산 칸, 불변조건, 실패하면 되돌리기
use std.[dom.*]

model Product
  name: Text        ? "펜"
  price: Number     ? 1000
  stock: Int        ? 2
  check .stock >= 0

model Line
  product: Product
  qty: Int          ? 1
  amount = .product.price * .qty

model Order
  lines: Line[]
  total: Number

model OutOfStock(product: Product)

products: Product[] = [Product(name: "펜", price: 1000, stock: 2), Product(name: "공책", price: 3000, stock: 0)]
cart: Line[] = []          ? [Line(product: products[0], qty: 3)]
orders: Order[] = []
error: Text? = none
total: Number = sum(cart.amount)    ! 3000

mount "#app"
  Shop

fn Shop()
  main
    h2 "상품"
    for product in products
      ProductCard product=product
    h2 "장바구니"
    ul
      for line in cart
        LineRow line=line
    p "합계 {total}원"
    p error  class="error"  if error
    button "주문하기"  onClick=checkout  disabled=(cart.count == 0)

fn ProductCard(product: Product)
  article
    strong product.name
    span "{product.price}원 · 재고 {product.stock}"  class="muted"
    button "담기"  onClick=add  disabled=(product.stock == 0)

  fn add()
    line: Line? = cart.find(.product == product)
    if line
      line.qty += 1
    else
      cart += Line(product: product, qty: 1)

fn LineRow(line: Line)
  li
    span line.product.name
    span "{line.qty}개"
    span "{line.amount}원"  class="muted"

fn checkout()
  for line in cart
    if line.product.stock < line.qty
      fail OutOfStock(product: line.product)
    line.product.stock -= line.qty
  orders += Order(lines: cart, total: total)
  cart = []
  error = none
catch OutOfStock(product)
  error = "{product.name} 재고가 부족해요"
