CREATE TABLE `ua_policies` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '行 id',
	`target_type` enum('global','app','user','api_key') NOT NULL COMMENT '名单对象类型',
	`target_id` bigint unsigned COMMENT '对象 id（global 时为空）',
	`mode` enum('block','allow') NOT NULL COMMENT '名单模式（block=黑名单，allow=白名单）',
	`patterns` json COMMENT '正则表达式字符串数组（匹配 User-Agent，不区分大小写）',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
	CONSTRAINT `ua_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_ua_policies_target` UNIQUE(`target_type`,`target_id`)
);
