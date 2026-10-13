ALTER TABLE "issue_execution_decisions" ADD COLUMN "target_assignee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "response_json" jsonb;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "wake_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_target_assignee_agent_id_agents_id_fk" FOREIGN KEY ("target_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations are transactional, so CONCURRENTLY is unavailable. This release introduces the stalled-review-agent-handoff key namespace, so existing deployments have no matching rows before this atomic wake-deduplication index is added.
CREATE UNIQUE INDEX "agent_wakeup_requests_stalled_review_agent_handoff_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'stalled-review-agent-handoff:%' AND "agent_wakeup_requests"."status" <> 'skipped';--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations are transactional, so CONCURRENTLY is unavailable. The new nullable idempotency_key column has no historical values, and this index must commit atomically before agent triage writers use it.
CREATE UNIQUE INDEX "issue_execution_decisions_stalled_review_idempotency_uq" ON "issue_execution_decisions" USING btree ("company_id","issue_id","idempotency_key") WHERE "issue_execution_decisions"."idempotency_key" IS NOT NULL;
