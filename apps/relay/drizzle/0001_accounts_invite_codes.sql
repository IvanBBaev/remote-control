CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	CONSTRAINT "invite_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD COLUMN "locator" text NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_codes_expires_at_idx" ON "invite_codes" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_locator_unique" UNIQUE("locator");