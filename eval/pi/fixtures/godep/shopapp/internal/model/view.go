// Package model 是对外接口的数据结构。
package model

// OrderView 是订单详情接口的返回体。
type OrderView struct {
	ID     int64  `json:"id"`
	Amount string `json:"amount"`
	Status string `json:"status"`
}
