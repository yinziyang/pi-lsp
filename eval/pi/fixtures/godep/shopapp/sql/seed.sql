-- 本地联调用的样例数据。
INSERT INTO orders (id, user_id, total, state) VALUES (1, 100, 129000, 0);
INSERT INTO orders (id, user_id, total, state) VALUES (2, 101, 5000, 1);
INSERT INTO refunds (id, order_id, amount) VALUES (1, 2, 5000);
