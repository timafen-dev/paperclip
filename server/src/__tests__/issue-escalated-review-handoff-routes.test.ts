import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: mockWakeup,
    }),
  };
});

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
    await db.delete(issueThreadInteractions);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    mockWakeup.mockClear();
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

  function boardActor(companyId: string) {
    return {
      type: "board",
      source: "session",
      userId: "local-board",
      companyIds: [companyId],
      memberships: [{
        companyId,
        status: "active",
        membershipRole: "operator",
      }],
      isInstanceAdmin: false,
    };
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

  it("keeps an exhausted review blocked and wakes the new assignee only after its blocker resolves", async () => {
    const seeded = await seed();
    const blockerIssueId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: seeded.companyId,
      identifier: "ERH-3",
      title: "Unresolved dependency",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: seeded.routineAgentId,
    });
    await db.insert(issueRelations).values({
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: seeded.targetIssueId,
      type: "blocks",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: seeded.companyId,
      issueId: seeded.targetIssueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      payload: {
        version: 1,
        questions: [{
          id: "approval",
          prompt: "Which action can continue?",
          selectionMode: "single",
          required: true,
          options: [{ id: "continue", label: "Continue" }],
        }],
      },
    });

    const actor = agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId);
    const response = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Keep the dependency and transfer the exhausted review.",
        idempotencyKey: randomUUID(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      replayed: false,
      issue: {
        id: seeded.targetIssueId,
        status: "blocked",
        assigneeAgentId: seeded.seniorAgentId,
        assigneeUserId: null,
      },
      wakeup: {
        agentId: seeded.seniorAgentId,
        status: "completed",
        reason: "escalated_review_handoff_blocked_receipt",
      },
    });
    expect(await db.select().from(issueRelations).where(and(
      eq(issueRelations.issueId, blockerIssueId),
      eq(issueRelations.relatedIssueId, seeded.targetIssueId),
    ))).toHaveLength(1);
    expect(await db.select().from(issueThreadInteractions).where(eq(
      issueThreadInteractions.id,
      interactionId,
    ))).toEqual([
      expect.objectContaining({
        status: "pending",
        effectiveResolverPolicy: "human_only",
      }),
    ]);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, seeded.seniorAgentId),
      eq(agentWakeupRequests.status, "queued"),
    ))).toHaveLength(0);
    expect(mockWakeup).not.toHaveBeenCalled();

    const blockerDone = await request(app(actor))
      .patch(`/api/issues/${blockerIssueId}`)
      .send({ status: "done" });
    expect(blockerDone.status, JSON.stringify(blockerDone.body)).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        seeded.seniorAgentId,
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: seeded.targetIssueId,
            resolvedBlockerIssueId: blockerIssueId,
          }),
        }),
      );
    });
  });

  it("recovers an exhausted review closed by an agent-authored stalled approval", async () => {
    const seeded = await seed();
    const actor = agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId);
    const approval = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/stalled-review-decision`)
      .send({ action: "approve", note: "Routine approval before handoff recovery." });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    expect(approval.body.issue).toMatchObject({
      id: seeded.targetIssueId,
      status: "done",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });

    const handoff = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "Recover the exhausted review from the routine approval.",
        idempotencyKey: randomUUID(),
      });

    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body).toMatchObject({
      replayed: false,
      issue: {
        id: seeded.targetIssueId,
        status: "in_progress",
        assigneeAgentId: seeded.seniorAgentId,
        assigneeUserId: null,
      },
    });
  });

  it("does not reopen a board-completed exhausted review", async () => {
    const seeded = await seed();
    await db.update(issues).set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, seeded.targetIssueId));

    const response = await request(app(agentActor(
      seeded.companyId,
      seeded.routineAgentId,
      seeded.runId,
    )))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "This completion has no agent approval proof.",
        idempotencyKey: randomUUID(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "issue_not_exhausted_escalated_review",
    });
    expect(await db.select().from(issues).where(eq(issues.id, seeded.targetIssueId))).toEqual([
      expect.objectContaining({
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      }),
    ]);
  });

  it("does not reuse an old agent approval after a later board completion", async () => {
    const seeded = await seed();
    const actor = agentActor(seeded.companyId, seeded.routineAgentId, seeded.runId);
    const approval = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/stalled-review-decision`)
      .send({ action: "approve", note: "Earlier agent approval." });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);

    await db.update(issues).set({ status: "in_review", completedAt: null })
      .where(eq(issues.id, seeded.targetIssueId));
    const boardCompletion = await request(app({
      ...boardActor(seeded.companyId),
      source: "local_implicit",
    }))
      .post(`/api/issues/${seeded.targetIssueId}/stalled-review-decision`)
      .send({ action: "approve", note: "Later board approval." });
    expect(boardCompletion.status, JSON.stringify(boardCompletion.body)).toBe(200);
    expect(boardCompletion.body.issue).toMatchObject({ status: "done" });

    const response = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({
        assigneeAgentId: seeded.seniorAgentId,
        comment: "An old agent approval must not recover a later completion.",
        idempotencyKey: randomUUID(),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "issue_not_exhausted_escalated_review",
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
    await db.update(heartbeatRuns).set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const second = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`).send(body);
    const conflicting = await request(app(actor))
      .post(`/api/issues/${seeded.targetIssueId}/escalated-review-handoff`)
      .send({ ...body, comment: "Different request." });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      replayed: true,
      issue: { id: seeded.targetIssueId, assigneeAgentId: seeded.seniorAgentId },
      wakeup: { id: first.body.wakeup.id },
      comment: { id: first.body.comment.id },
      decision: { id: first.body.decision.id },
    });
    expect(conflicting.status, JSON.stringify(conflicting.body)).toBe(409);
    expect(conflicting.body.details).toMatchObject({
      code: "escalated_review_handoff_idempotency_conflict",
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

  it("replays the twentieth cross-issue handoff without spending a twenty-first allowance", async () => {
    const seeded = await seed();
    await db.insert(activityLog).values(
      Array.from({ length: 19 }, () => ({
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.routineAgentId,
        agentId: seeded.routineAgentId,
        runId: seeded.runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: seeded.targetIssueId,
        details: { kind: "update" },
      })),
    );
    const body = {
      assigneeAgentId: seeded.seniorAgentId,
      comment: "Boundary replay.",
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
      wakeup: { id: first.body.wakeup.id },
      comment: { id: first.body.comment.id },
      decision: { id: first.body.decision.id },
    });
    const influenceRows = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, seeded.runId),
      eq(activityLog.action, "issue.cross_issue_influence_observed"),
    ));
    expect(influenceRows).toHaveLength(20);
  });
});
