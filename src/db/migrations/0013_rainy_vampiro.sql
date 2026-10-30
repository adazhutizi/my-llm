ALTER TABLE `api_keys` ADD `borrowed_upstream_key` text COMMENT '借调中的上游 key 快照（明文存储，禁查）';--> statement-breakpoint
ALTER TABLE `api_keys` ADD `borrowed_provider_id` bigint unsigned COMMENT '借调期间路由的服务商 id，可空';--> statement-breakpoint
ALTER TABLE `api_keys` ADD `borrow_expires_at` datetime COMMENT '借调到期时间（过期自动回退原 key），可空=不限期';--> statement-breakpoint
ALTER TABLE `api_keys` ADD `borrow_started_at` datetime COMMENT '借调开始时间（可预约未来，空=立即开始），可空';--> statement-breakpoint
ALTER TABLE `api_keys` ADD `borrow_note` varchar(200) COMMENT '借调备注，可空';