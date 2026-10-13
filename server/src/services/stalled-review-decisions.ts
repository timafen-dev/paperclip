import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";

export type StalledReviewDecisionActor =
  | { type: "user"; userId: string; runId?: string | null }
  | { type: "agent"; agentId: string; runId: string };

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  assigneeAgentId?: string;
  idempotencyKey?: string;
  actor: StalledReviewDecisionActor;
}

type StoredAgentDecisionResponse = {
  issue: { id: string };
  comment: { id: string };
};

const AGENT_WAKE_CLAIM_LEASE_MS = 5 * 60_000;

function agentDecisionRequestFingerprint(input: DecideStalledReviewInput) {
  if (input.actor.type !== "agent") throw new Error("Agent decision actor required");
  return JSON.stringify({
    action: input.action,
    note: input.note ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    actorAgentId: input.actor.agentId,
  });
}

function storedAgentResponse(value: unknown): StoredAgentDecisionResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const issue = response.issue;
  const comment = response.comment;
  if (
    !issue || typeof issue !== "object" || Array.isArray(issue) ||
    typeof (issue as Record<string, unknown>).id !== "string" ||
    !comment || typeof comment !== "object" || Array.isArray(comment) ||
    typeof (comment as Record<string, unknown>).id !== "string"
  ) return null;
  return response as StoredAgentDecisionResponse;
}

export function stalledReviewDecisionService(db: Db) {
  const svc = issueService(db);

  async function decideForAgent(input: DecideStalledReviewInput & {
    actor: Extract<StalledReviewDecisionActor, { type: "agent" }>;
    assigneeAgentId: string;
    idempotencyKey: string;
  }) {
    if (input.action !== "request_changes") {
      throw unprocessable("Agent stalled-review triage only supports request_changes");
    }
    const note = input.note;
    if (!note?.trim()) {
      throw unprocessable("Agent stalled-review triage requires a note");
    }

    const requestHash = agentDecisionRequestFingerprint(input);
    const postCommitActivityPublications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
        executionIssueCondition(),
      )).for("update").then((rows) => rows[0] ?? null);
      if (!lockedIssue) throw notFound("Issue not found");

      await assertAgentRunWriteAllowed(txDb, lockedIssue.companyId, {
        agentId: input.actor.agentId,
        runId: input.actor.runId,
      });
      const activeRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.actor.runId),
        eq(heartbeatRuns.companyId, lockedIssue.companyId),
        eq(heartbeatRuns.agentId, input.actor.agentId),
        eq(heartbeatRuns.status, "running"),
      )).for("share").then((rows) => rows[0] ?? null);
      if (!activeRun) {
        throw forbidden("An active authenticated agent run is required", {
          code: "stalled_review_triage_active_run_required",
        });
      }

      const existingDecision = await tx.select().from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.companyId, lockedIssue.companyId),
        eq(issueExecutionDecisions.issueId, lockedIssue.id),
        eq(issueExecutionDecisions.idempotencyKey, input.idempotencyKey),
      )).then((rows) => rows[0] ?? null);
      if (existingDecision) {
        if (existingDecision.requestHash !== requestHash) {
          throw conflict("Idempotency key was already used for a different stalled-review decision", {
            code: "stalled_review_decision_idempotency_mismatch",
          });
        }
        const response = storedAgentResponse(existingDecision.responseJson);
        if (!response) {
          throw conflict("The prior stalled-review decision receipt is incomplete", {
            code: "stalled_review_decision_receipt_incomplete",
          });
        }
        const replayComment = await tx.select().from(issueComments).where(and(
          eq(issueComments.companyId, lockedIssue.companyId),
          eq(issueComments.issueId, lockedIssue.id),
          eq(issueComments.id, response.comment.id),
        )).then((rows) => rows[0] ?? null);
        if (!replayComment) {
          throw conflict("The prior stalled-review decision comment is missing", {
            code: "stalled_review_decision_receipt_incomplete",
          });
        }
        return {
          issue: lockedIssue,
          comment: replayComment,
          decisionId: existingDecision.id,
          replayed: true,
          wakeQueued: existingDecision.wakeQueuedAt !== null,
        };
      }

      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }
      const reviewAttention = await svc.listReviewAttention(
        lockedIssue.companyId,
        [lockedIssue],
        tx,
      ).then((rows) => rows.get(lockedIssue.id));
      if (reviewAttention?.state !== "stalled") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      const executionState = parseIssueExecutionState(lockedIssue.executionState);
      if (
        executionState?.status !== "pending" ||
        executionState.currentParticipant?.type !== "user" ||
        executionState.currentParticipant.userId !== "local-board" ||
        !executionState.currentStageId ||
        !executionState.currentStageType
      ) {
        throw conflict("Stalled review is not held by local-board", {
          code: "stalled_review_not_local_board",
        });
      }
      if (
        executionState.returnAssignee?.type === "agent" &&
        executionState.returnAssignee.agentId === input.assigneeAgentId
      ) {
        throw conflict("Stalled review cannot be returned to the previous executor", {
          code: "stalled_review_previous_executor_forbidden",
        });
      }
      await assertAssignableAgent(txDb, lockedIssue.companyId, input.assigneeAgentId, { kind: "work" });

      const comment = await svc.addComment(
        lockedIssue.id,
        note,
        { agentId: input.actor.agentId, runId: input.actor.runId },
        { authorType: "agent" },
        tx,
      );
      const updated = await tx.update(issues).set({
        status: "todo",
        assigneeAgentId: input.assigneeAgentId,
        assigneeUserId: null,
        executionState: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: null,
        cancelledAt: null,
        statusVersion: sql`${issues.statusVersion} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(issues.id, lockedIssue.id),
        eq(issues.companyId, lockedIssue.companyId),
      )).returning().then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Issue not found");

      const decisionId = randomUUID();
      const responseJson: StoredAgentDecisionResponse = {
        issue: { id: updated.id },
        comment: { id: comment.id },
      };
      await tx.insert(issueExecutionDecisions).values({
        id: decisionId,
        companyId: updated.companyId,
        issueId: updated.id,
        stageId: executionState.currentStageId,
        stageType: executionState.currentStageType,
        actorAgentId: input.actor.agentId,
        actorUserId: null,
        outcome: "changes_requested",
        body: note,
        createdByRunId: input.actor.runId,
        targetAssigneeAgentId: input.assigneeAgentId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        responseJson,
      });

      const activityBase = {
        companyId: updated.companyId,
        actorType: "agent" as const,
        actorId: input.actor.agentId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
      };
      await logActivity(txDb, {
        ...activityBase,
        action: "issue.updated",
        details: {
          status: "todo",
          assigneeAgentId: input.assigneeAgentId,
          assigneeUserId: null,
          source: "stalled_review_decision",
          _previous: {
            status: lockedIssue.status,
            assigneeAgentId: lockedIssue.assigneeAgentId,
            assigneeUserId: lockedIssue.assigneeUserId,
          },
        },
      }, postCommitActivityPublications);
      await logActivity(txDb, {
        ...activityBase,
        action: "issue.comment_added",
        details: {
          commentId: comment.id,
          authorAgentId: input.actor.agentId,
          createdByRunId: input.actor.runId,
          source: "stalled_review_decision",
        },
      }, postCommitActivityPublications);
      await logActivity(txDb, {
        ...activityBase,
        action: "issue.stalled_review_decided",
        details: {
          action: input.action,
          status: "todo",
          identifier: updated.identifier,
          commentId: comment.id,
          authorAgentId: input.actor.agentId,
          targetAssigneeAgentId: input.assigneeAgentId,
          idempotencyKey: input.idempotencyKey,
          _previous: { status: lockedIssue.status },
        },
      }, postCommitActivityPublications);

      return {
        issue: updated,
        comment,
        decisionId,
        replayed: false,
        wakeQueued: false,
      };
    });
    for (const publication of postCommitActivityPublications) publishActivity(publication);
    return result;
  }

  return {
    decide: async (input: DecideStalledReviewInput) => {
      if (input.actor.type === "agent") {
        if (!input.assigneeAgentId || !input.idempotencyKey) {
          throw unprocessable("Agent stalled-review triage requires assigneeAgentId and idempotencyKey");
        }
        return decideForAgent({
          ...input,
          actor: input.actor,
          assigneeAgentId: input.assigneeAgentId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      if (input.assigneeAgentId || input.idempotencyKey) {
        throw unprocessable("Board stalled-review decisions do not accept agent handoff fields");
      }
      const userActor = input.actor;
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            executionIssueCondition(),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!lockedIssue) throw notFound("Issue not found");
        if (lockedIssue.status !== "in_review") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            currentStatus: lockedIssue.status,
          });
        }

        const reviewAttention = await svc
          .listReviewAttention(lockedIssue.companyId, [lockedIssue], tx)
          .then((rows) => rows.get(lockedIssue.id));
        if (reviewAttention?.state !== "stalled") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            reviewAttentionState: reviewAttention?.state ?? "none",
          });
        }

        const comment = input.note
          ? await svc.addComment(
              lockedIssue.id,
              input.note,
              { userId: userActor.userId, runId: userActor.runId ?? null },
              { authorType: "user" },
              tx,
            )
          : null;
        const status = input.action === "approve" ? "done" : "todo";
        const updated = await svc.update(
          lockedIssue.id,
          {
            status,
            actorUserId: userActor.userId,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        if (comment) {
          await logActivity(txDb, {
            companyId: updated.companyId,
            actorType: "user",
            actorId: userActor.userId,
            runId: userActor.runId ?? null,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: updated.id,
            issueId: updated.id,
            details: {
              commentId: comment.id,
              authorUserId: userActor.userId,
              source: "stalled_review_decision",
            },
          });
        }
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: userActor.userId,
          runId: userActor.runId ?? null,
          action: "issue.stalled_review_decided",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            status,
            identifier: updated.identifier,
            commentId: comment?.id ?? null,
            authorUserId: comment ? userActor.userId : null,
            _previous: { status: lockedIssue.status },
          },
        });

        return {
          issue: updated,
          comment,
          decisionId: null,
          replayed: false,
          wakeQueued: false,
        };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },

    ensureAgentWakeQueued: async (input: {
      companyId: string;
      decisionId: string;
      enqueue: () => Promise<unknown | null>;
    }) => {
      const claimToken = randomUUID();
      const claimCutoff = new Date(Date.now() - AGENT_WAKE_CLAIM_LEASE_MS);
      const claim = await db.transaction(async (tx) => {
        const decision = await tx
          .select({
            wakeQueuedAt: issueExecutionDecisions.wakeQueuedAt,
            wakeClaimToken: issueExecutionDecisions.wakeClaimToken,
            wakeClaimedAt: issueExecutionDecisions.wakeClaimedAt,
          })
          .from(issueExecutionDecisions)
          .where(and(
            eq(issueExecutionDecisions.id, input.decisionId),
            eq(issueExecutionDecisions.companyId, input.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!decision) throw notFound("Stalled-review decision receipt not found");
        if (decision.wakeQueuedAt) return "queued" as const;
        if (
          decision.wakeClaimToken &&
          decision.wakeClaimedAt &&
          decision.wakeClaimedAt > claimCutoff
        ) return "claimed" as const;
        await tx.update(issueExecutionDecisions).set({
          wakeClaimToken: claimToken,
          wakeClaimedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(issueExecutionDecisions.id, input.decisionId),
          eq(issueExecutionDecisions.companyId, input.companyId),
        ));
        return "acquired" as const;
      });
      if (claim === "queued") return true;
      if (claim === "claimed") return false;

      try {
        const wake = await input.enqueue();
        await db.update(issueExecutionDecisions).set({
          wakeClaimToken: null,
          wakeClaimedAt: null,
          ...(wake === null ? {} : { wakeQueuedAt: new Date() }),
          updatedAt: new Date(),
        }).where(and(
          eq(issueExecutionDecisions.id, input.decisionId),
          eq(issueExecutionDecisions.companyId, input.companyId),
          eq(issueExecutionDecisions.wakeClaimToken, claimToken),
        ));
        return wake !== null;
      } catch (error) {
        await db.update(issueExecutionDecisions).set({
          wakeClaimToken: null,
          wakeClaimedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(issueExecutionDecisions.id, input.decisionId),
          eq(issueExecutionDecisions.companyId, input.companyId),
          eq(issueExecutionDecisions.wakeClaimToken, claimToken),
        ));
        throw error;
      }
    },
  };
}
