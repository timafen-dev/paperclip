ALTER TABLE "issue_execution_decisions" ADD COLUMN "wake_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "wake_claimed_at" timestamp with time zone;