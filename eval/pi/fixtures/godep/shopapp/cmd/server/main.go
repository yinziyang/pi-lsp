package main

import (
	"context"
	"fmt"
	"os"

	"example.com/shopapp/internal/checkout"
	"example.com/shopdb"
)

func main() {
	db, err := shopdb.Open(shopdb.Options{DSN: os.Getenv("SHOP_DSN"), IdleTimeout: 30, MaxOpen: 20})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	svc := checkout.New(db)
	if err := svc.Pay(context.Background(), 42); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
