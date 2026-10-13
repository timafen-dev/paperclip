import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueExecutionDecisions = pgTable(
  "issue_execution_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull(),
    stageType: text("stage_type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id"),
    outcome: text("outcome").notNull(),
    body: text("body").notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    targetAssigneeAgentId: uuid("target_assignee_agent_id").references(() => agents.id),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    wakeQueuedAt: timestamp("wake_queued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_execution_decisions_company_issue_idx").on(table.companyId, table.issueId),
    stageIdx: index("issue_execution_decisions_stage_idx").on(table.issueId, table.stageId, table.createdAt),
    stalledReviewIdempotencyUq: uniqueIndex("issue_execution_decisions_stalled_review_idempotency_uq")
      .on(table.companyId, table.issueId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);
