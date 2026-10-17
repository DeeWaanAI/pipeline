CREATE TABLE `device_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_device_codes_device_code` ON `device_codes` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_device_codes_user_code` ON `device_codes` (`user_code`);