// Package shopdb 是商城库的连接与表定义，供各服务共享。
package shopdb

import (
	"context"
	"errors"
)

// Options 是连接参数。
type Options struct {
	// DSN 连接串。
	DSN string
	// IdleTimeout 空闲连接回收间隔，单位：分钟，0 表示不回收。
	IdleTimeout int
	// MaxOpen 最大连接数。
	MaxOpen int
}

// DB 是一个打开的连接池。
type DB struct{ opts Options }

// Open 按 opts 打开连接池。
func Open(opts Options) (*DB, error) {
	if opts.DSN == "" {
		return nil, errors.New("shopdb: empty DSN")
	}
	return &DB{opts: opts}, nil
}

// Table 是一张表的类型化句柄。
type Table[T any] struct{ name string }

// Get 按主键读一行。
func (t Table[T]) Get(ctx context.Context, db *DB, id int64) (T, error) {
	var zero T
	return zero, ctx.Err()
}
