import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("escalated review handoff routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-escalated-review-handoff-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  async function seed() {
    const companyId = randomUUID();
    const routineAgentId = randomUUID();
    const seniorAgentId = randomUUID();
    const previousAgentId = randomUUID();
    const outsiderAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const stageId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Escalated Review Company",
      issuePrefix: "ERH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [routineAgentId, seniorAgentId, previousAgentId, outsiderAgentId].map((id, index) => ({
        id,
        companyId,
        name: `Agent ${index + 1}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        identifier: "ERH-1",
        title: "Triage routine execution",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: routineAgentId,
        originKind: "routine_execution",
        originId: randomUUID(),
      },
      {
        id: targetIssueId,
        companyId,
        identifier: "ERH-2",
        title: "Escalated review",
        status: "in_review",
        priority: "high",
        assigneeUserId: "local-board",
        responsibleUserId: "local-board",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          maxReviewRounds: 3,
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: previousAgentId }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "user", userId: "local-board", agentId: null },
          returnAssignee: { type: "agent", agentId: previousAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: randomUUID(),
          lastDecisionOutcome: "changes_requested",
          monitor: null,
          changesRequestedCount: 3,
        },
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: routineAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      nativeIssueId: sourceIssueId,
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId })
      .where(eq(issues.id, sourceIssueId));

    return {
      companyId,
      routineAgentId,
      seniorAgentId,
      previousAgentId,
      outsiderAgentId,
      sourceIssueId,
      targetIssueId,
      runId,
    };
  }

  it("hands an exhausted review to the requested agent with an atomic audit and wake receipt", async () => {
    const seeded = await seed();
    const response = await request(app(agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId)))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Третий круг исчерпан. Передаю Старшему инженеру.",
        idempotencyKey: randomUUID(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      replayed: false,
      issue: {
        id: seeded.targetIssueId,
        status: "in_progress",
        assigneeAgentId: seeded.seniorAgentId,
        assigneeUserId: null,
        executionState: {
          status: "changes_requested",
          currentParticipant: { type: "user", userId: "local-board" },
          returnAssignee: { type: "agent", agentId: seeded.seniorAgentId },
          lastDecisionOutcome: "changes_requested",
          changesRequestedCount: 0,
        },
      },
      decision: {
        issueId: seeded.targetIssueId,
        actorAgentId: seeded.routineAgentId,
        actorUserId: null,
        outcome: "changes_requested",
      },
      comment: {
        issueId: seeded.targetIssueId,
        authorAgentId: seeded.routineAgentId,
        authorUserId: null,
      },
      wakeup: {
        agentId: seeded.seniorAgentId,
        status: "queued",
        payload: { issueId: seeded.targetIssueId },
      },
    });

    const [audit] = await db.select().from(activityLog)
      .where(eq(activityLog.action, "issue.escalated_review_handed_off"));
    expect(audit).toMatchObject({
      actorType: "agent",
      actorId: seeded.routineAgentId,
      agentId: seeded.routineAgentId,
      runId: seeded.runId,
      entityId: seeded.targetIssueId,
      details: {
        sourceRoutineIssueId: seeded.sourceIssueId,
        previousReturnAssigneeAgentId: seeded.previousAgentId,
        assigneeAgentId: seeded.seniorAgentId,
      },
    });
  });

  it("rejects arbitrary user attribution and leaves the review unchanged", async () => {
    const seeded = await seed();
    const response = await request(app(agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId)))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Pretend the board requested this.",
        idempotencyKey: randomUUID(),
        onBehalfOfUserId: "local-board",
      });

    expect(response.status).toBe(400);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, seeded.targetIssueId));
    expect(persisted).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
  });

  it("rejects a non-routine agent and preserves currentParticipant enforcement", async () => {
    const seeded = await seed();
    const outsiderIssueId = randomUUID();
    const outsiderRunId = randomUUID();
    await db.insert(issues).values({
      id: outsiderIssueId,
      companyId: seeded.companyId,
      identifier: "ERH-3",
      title: "Unrelated task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.outsiderAgentId,
      originKind: "manual",
    });
    await db.insert(heartbeatRuns).values({
      id: outsiderRunId,
      companyId: seeded.companyId,
      agentId: seeded.outsiderAgentId,
      invocationSource: "assignment",
      status: "running",
      nativeIssueId: outsiderIssueId,
      contextSnapshot: { issueId: outsiderIssueId },
    });
    await db.update(issues).set({ checkoutRunId: outsiderRunId, executionRunId: outsiderRunId })
      .where(eq(issues.id, outsiderIssueId));

    const actor = agentActor(seeded.companyId, seeded.outsiderAgentId, outsiderRunId);
    const handoff = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Unauthorized handoff.",
        idempotencyKey: randomUUID(),
      });
    expect(handoff.status).toBe(403);

    const genericPatch = await request(app(actor))
      .patch(`/api/issues/${seeded.targetIssueId}`)
      .send({
        status: "in_progress",
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Unauthorized generic transition.",
      });
    expect(genericPatch.status).toBe(422);
    expect(genericPatch.body.error).toContain("Only the escalated reviewer can advance");
  });

  it("replays without duplicate comments, decisions, audit rows, or wakeups", async () => {
    const seeded = await seed();
    const body = {
      assigneeAgentId: seeded.seniorAgentId,
      comment: "Escalation handoff.",
      idempotencyKey: randomUUID(),
    };
    const actor = agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId);
    const first = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`).send(body);
    const second = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`).send(body);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      replayed: true,
      issue: { id: seeded.targetIssueId, assigneeAgentId: seeded.seniorAgentId },
      wakeup: { id: first.body.wakeup.id },
      comment: { id: first.body.comment.id },
      decision: { id: first.body.decision.id },
    });

    const [comments, decisions, wakeups, audits] = await Promise.all([
      db.select().from(issueComments).where(eq(issueComments.issueId, seeded.targetIssueId)),
      db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.targetIssueId)),
      db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, seeded.companyId),
        eq(agentWakeupRequests.agentId, seeded.seniorAgentId),
      )),
      db.select().from(activityLog).where(eq(activityLog.action, "issue.escalated_review_handed_off")),
    ]);
    expect(comments).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(wakeups).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});
