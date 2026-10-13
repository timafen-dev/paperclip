import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";

const IDEMPOTENCY_PREFIX = "escalated-review-handoff";

export interface EscalatedReviewHandoffActor {
  agentId: string;
  runId: string;
}

export interface EscalatedReviewHandoffInput {
  issueId: string;
  companyId: string;
  assigneeAgentId: string;
  comment: string;
  idempotencyKey: string;
  actor: EscalatedReviewHandoffActor;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function sourceIssueIdForRun(run: {
  nativeIssueId: string | null;
  contextSnapshot: Record<string, unknown> | null;
}) {
  return (
    run.nativeIssueId ??
    readString(run.contextSnapshot?.issueId) ??
    readString(run.contextSnapshot?.taskId)
  );
}

function requestHash(input: Pick<EscalatedReviewHandoffInput, "assigneeAgentId" | "comment">) {
  return createHash("sha256")
    .update(`${input.assigneeAgentId}\0${input.comment.trim()}`)
    .digest("hex");
}

function receiptPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  return {
    issueId: readString(payload.issueId),
    assigneeAgentId: readString(payload.assigneeAgentId),
    commentId: readString(payload.commentId),
    decisionId: readString(payload.decisionId),
    sourceRoutineIssueId: readString(payload.sourceRoutineIssueId),
    sourceRunId: readString(payload.sourceRunId),
    requestHash: readString(payload.requestHash),
  };
}

export function escalatedReviewHandoffService(db: Db) {
  const svc = issueService(db);

  return {
    handoff: async (input: EscalatedReviewHandoffInput) => {
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const namespacedIdempotencyKey = `${IDEMPOTENCY_PREFIX}:${input.issueId}:${input.idempotencyKey}`;
      const expectedRequestHash = requestHash(input);

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.issueId),
              eq(issues.companyId, input.companyId),
              executionIssueCondition(),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) throw notFound("Issue not found");

        const run = await tx
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            nativeIssueId: heartbeatRuns.nativeIssueId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, input.actor.runId),
              eq(heartbeatRuns.companyId, input.companyId),
              eq(heartbeatRuns.agentId, input.actor.agentId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        const sourceIssueId = run ? sourceIssueIdForRun(run) : null;
        const sourceIssue = sourceIssueId
          ? await tx
              .select({
                id: issues.id,
                status: issues.status,
                originKind: issues.originKind,
                assigneeAgentId: issues.assigneeAgentId,
                checkoutRunId: issues.checkoutRunId,
                executionRunId: issues.executionRunId,
              })
              .from(issues)
              .where(
                and(
                  eq(issues.id, sourceIssueId),
                  eq(issues.companyId, input.companyId),
                  executionIssueCondition(),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        const assignedRoutineRun =
          run?.status === "running" &&
          sourceIssue?.originKind === "routine_execution" &&
          sourceIssue.status === "in_progress" &&
          sourceIssue.assigneeAgentId === input.actor.agentId &&
          (sourceIssue.checkoutRunId === input.actor.runId ||
            sourceIssue.executionRunId === input.actor.runId);
        if (!assignedRoutineRun || !sourceIssue) {
          throw forbidden(
            "An active assigned routine execution is required for an escalated review handoff",
          );
        }

        const existingWakeup = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, input.companyId),
              eq(agentWakeupRequests.idempotencyKey, namespacedIdempotencyKey),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existingWakeup) {
          const receipt = receiptPayload(existingWakeup.payload);
          if (
            receipt?.issueId !== input.issueId ||
            receipt.assigneeAgentId !== input.assigneeAgentId ||
            receipt.sourceRoutineIssueId !== sourceIssue.id ||
            receipt.sourceRunId !== input.actor.runId ||
            receipt.requestHash !== expectedRequestHash
          ) {
            throw conflict(
              "Handoff idempotency key was already used for a different request",
              { code: "escalated_review_handoff_idempotency_conflict" },
            );
          }
          const [comment, decision] = await Promise.all([
            receipt.commentId
              ? tx
                  .select()
                  .from(issueComments)
                  .where(eq(issueComments.id, receipt.commentId))
                  .then((rows) => rows[0] ?? null)
              : null,
            receipt.decisionId
              ? tx
                  .select()
                  .from(issueExecutionDecisions)
                  .where(eq(issueExecutionDecisions.id, receipt.decisionId))
                  .then((rows) => rows[0] ?? null)
              : null,
          ]);
          if (!comment || !decision) {
            throw conflict("Escalated review handoff receipt is incomplete", {
              code: "escalated_review_handoff_receipt_incomplete",
            });
          }
          return {
            issue: lockedIssue,
            comment,
            decision,
            wakeup: existingWakeup,
            replayed: true,
          };
        }

        const policy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy);
        const state = parseIssueExecutionState(lockedIssue.executionState);
        const maxReviewRounds =
          typeof policy?.maxReviewRounds === "number" && policy.maxReviewRounds > 0
            ? policy.maxReviewRounds
            : DEFAULT_MAX_REVIEW_ROUNDS;
        const stage = policy?.stages.find(
          (candidate) => candidate.id === state?.currentStageId,
        );
        const isExhaustedEscalatedReview =
          lockedIssue.status === "in_review" &&
          lockedIssue.assigneeAgentId === null &&
          lockedIssue.assigneeUserId != null &&
          state?.status === "pending" &&
          state.currentStageType === "review" &&
          stage?.type === "review" &&
          state.currentParticipant?.type === "user" &&
          state.currentParticipant.userId === lockedIssue.assigneeUserId &&
          state.lastDecisionOutcome === "changes_requested" &&
          state.changesRequestedCount >= maxReviewRounds;
        if (!isExhaustedEscalatedReview || !state || !stage) {
          throw conflict("Issue is not an exhausted escalated review", {
            code: "issue_not_exhausted_escalated_review",
            issueId: lockedIssue.id,
          });
        }

        const decisionId = randomUUID();
        const comment = await svc.addComment(
          lockedIssue.id,
          input.comment.trim(),
          { agentId: input.actor.agentId, runId: input.actor.runId },
          { authorType: "agent" },
          tx,
        );
        const [decision] = await tx
          .insert(issueExecutionDecisions)
          .values({
            id: decisionId,
            companyId: lockedIssue.companyId,
            issueId: lockedIssue.id,
            stageId: stage.id,
            stageType: stage.type,
            actorAgentId: input.actor.agentId,
            actorUserId: null,
            outcome: "changes_requested",
            body: input.comment.trim(),
            createdByRunId: input.actor.runId,
          })
          .returning();
        if (!decision) {
          throw new Error("Failed to record escalated review handoff decision");
        }
        const updated = await svc.update(
          lockedIssue.id,
          {
            status: "in_progress",
            assigneeAgentId: input.assigneeAgentId,
            assigneeUserId: null,
            executionState: {
              ...state,
              status: "changes_requested",
              returnAssignee: {
                type: "agent",
                agentId: input.assigneeAgentId,
                userId: null,
              },
              reviewRequest: null,
              lastDecisionId: decision.id,
              lastDecisionOutcome: "changes_requested",
              changesRequestedCount: 0,
            },
            actorAgentId: input.actor.agentId,
            actorRunId: input.actor.runId,
            companyGuard: input.companyId,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        const [wakeup] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: input.companyId,
            agentId: input.assigneeAgentId,
            source: "automation",
            triggerDetail: "system",
            reason: "issue_assigned",
            requestedByActorType: "agent",
            requestedByActorId: input.actor.agentId,
            idempotencyKey: namespacedIdempotencyKey,
            payload: {
              issueId: lockedIssue.id,
              mutation: "escalated_review_handoff",
              assigneeAgentId: input.assigneeAgentId,
              commentId: comment.id,
              decisionId: decision.id,
              sourceRoutineIssueId: sourceIssue.id,
              sourceRunId: input.actor.runId,
              requestHash: expectedRequestHash,
            },
          })
          .returning();
        if (!wakeup) {
          throw new Error("Failed to queue escalated review handoff wakeup");
        }

        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "agent",
          actorId: input.actor.agentId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorAgentId: input.actor.agentId,
            source: "escalated_review_handoff",
          },
        });
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "agent",
          actorId: input.actor.agentId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: "issue.escalated_review_handed_off",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            sourceRoutineIssueId: sourceIssue.id,
            assigneeAgentId: input.assigneeAgentId,
            previousAssigneeUserId: lockedIssue.assigneeUserId,
            previousReturnAssigneeAgentId:
              state.returnAssignee?.type === "agent"
                ? state.returnAssignee.agentId
                : null,
            commentId: comment.id,
            decisionId: decision.id,
            wakeupRequestId: wakeup.id,
            _previous: {
              status: lockedIssue.status,
              assigneeAgentId: lockedIssue.assigneeAgentId,
              assigneeUserId: lockedIssue.assigneeUserId,
            },
          },
        });

        return { issue: updated, comment, decision, wakeup, replayed: false };
      });

      for (const publication of postCommitActivityPublications) {
        publishActivity(publication);
      }
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      const currentIssue = await svc.getById(input.issueId);
      if (!currentIssue) throw notFound("Issue not found");
      return { ...result, issue: currentIssue };
    },
  };
}
