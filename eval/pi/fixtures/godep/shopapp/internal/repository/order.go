// Package repository 封装订单的读写。
package repository

import (
	"context"

	"example.com/shopdb"
)

// OrderRepo 读写订单。
type OrderRepo struct{ db *shopdb.DB }

// NewOrderRepo 创建 OrderRepo。
func NewOrderRepo(db *shopdb.DB) *OrderRepo { return &OrderRepo{db: db} }

// Find 按主键读订单。
func (r *OrderRepo) Find(ctx context.Context, id int64) (shopdb.Order, error) {
	return shopdb.Orders.Get(ctx, r.db, id)
}

// FindRefund 按主键读退款。
func (r *OrderRepo) FindRefund(ctx context.Context, id int64) (shopdb.Refund, error) {
	return shopdb.Refunds.Get(ctx, r.db, id)
}
