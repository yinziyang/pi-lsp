package shopdb

// Order 是 orders 表的一行。
type Order struct {
	// ID 主键。
	ID int64
	// UserID 下单用户。
	UserID int64
	// Total 订单应付金额，单位：厘（千分之一元）。
	Total int64
	// State 订单状态：0 待支付，1 已支付，2 已取消。
	State int8
}

// Orders 是 orders 表。
var Orders = Table[Order]{name: "orders"}

// Refund 是 refunds 表的一行。
type Refund struct {
	// ID 主键。
	ID int64
	// OrderID 所属订单。
	OrderID int64
	// Amount 退款金额，单位同 Order.Total。
	Amount int64
}

// Refunds 是 refunds 表。
var Refunds = Table[Refund]{name: "refunds"}
