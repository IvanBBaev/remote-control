CREATE TABLE "verified_decisions" (
	"decision_hash" "bytea" PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"used_until" timestamp with time zone NOT NULL,
	"verified_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"device_id" text,
	"invite_id" text,
	"webauthn_user_id" text,
	"display_name" text,
	"recovery_code_id" text,
	"decision_hash" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webauthn_challenges_kind_check" CHECK ("webauthn_challenges"."kind" in ('register', 'login', 'recovery', 'decision'))
);
--> statement-breakpoint
CREATE INDEX "verified_decisions_used_until_idx" ON "verified_decisions" USING btree ("used_until");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" USING btree ("expires_at");