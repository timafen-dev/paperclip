import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueExecutionDecisions } from "./schema/issue_execution_decisions.js";

describe("issue execution decision schema", () => {
  it("stores one durable stalled-review handoff receipt per issue and key", () => {
    const config = getTableConfig(issueExecutionDecisions);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "issue_execution_decisions_stalled_review_idempotency_uq",
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "company_id",
      "issue_id",
      "idempotency_key",
    ]);
    expect(index?.config.where).toBeDefined();
    expect(config.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "target_assignee_agent_id",
      "request_hash",
      "response_json",
      "wake_claim_token",
      "wake_claimed_at",
      "wake_queued_at",
    ]));
  });
});
