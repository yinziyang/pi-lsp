// Package checkout 处理支付。
package checkout

import (
	"context"
	"fmt"

	"example.com/shopdb"
)

// Service 处理订单支付。
type Service struct{ db *shopdb.DB }

// New 创建 Service。
func New(db *shopdb.DB) *Service { return &Service{db: db} }

// Pay 支付一笔订单。
func (s *Service) Pay(ctx context.Context, id int64) error {
	o, err := shopdb.Orders.Get(ctx, s.db, id)
	if err != nil {
		return fmt.Errorf("load order %d: %w", id, err)
	}
	if o.State != 0 {
		return fmt.Errorf("order %d not payable", id)
	}
	return charge(o.UserID, o.Total)
}

func charge(user, amount int64) error {
	_, _ = user, amount // 示例：真实扣款不在本工程内。
	return nil
}
