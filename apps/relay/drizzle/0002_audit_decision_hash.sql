ALTER TABLE "audit_log" ADD COLUMN "decision_hash" "bytea";--> statement-breakpoint
CREATE INDEX "audit_log_event_at_idx" ON "audit_log" USING btree ("event","at");