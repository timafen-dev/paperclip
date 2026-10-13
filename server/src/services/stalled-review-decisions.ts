import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";

export interface StalledReviewDecisionActor {
  actorType: "agent" | "user";
  actorId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  const svc = issueService(db);
  return {
    decide: async (input: DecideStalledReviewInput) => {
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
          lockedIssue.assigneeAgentId === null &&
          lockedIssue.assigneeUserId != null &&
          state?.status === "pending" &&
          state.currentStageType === "review" &&
          stage?.type === "review" &&
          state.currentParticipant?.type === "user" &&
          state.currentParticipant.userId === lockedIssue.assigneeUserId &&
          state.lastDecisionOutcome === "changes_requested" &&
          (state.changesRequestedCount ?? 0) >= maxReviewRounds;
        if (
          reviewAttention?.state !== "stalled" &&
          !isExhaustedEscalatedReview
        ) {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            reviewAttentionState: reviewAttention?.state ?? "none",
          });
        }

        const actorRunId = input.actor.runId ?? null;
        const actorIsAgent = input.actor.actorType === "agent";
        const commentActor = actorIsAgent
          ? { agentId: input.actor.actorId, runId: actorRunId }
          : { userId: input.actor.actorId, runId: actorRunId };
        const comment = input.note
          ? await svc.addComment(
              lockedIssue.id,
              input.note,
              commentActor,
              { authorType: input.actor.actorType },
              tx,
            )
          : null;
        const status = input.action === "approve" ? "done" : "todo";
        const updated = await svc.update(
          lockedIssue.id,
          {
            status,
            actorAgentId: actorIsAgent ? input.actor.actorId : null,
            actorRunId: actorIsAgent ? actorRunId : null,
            actorUserId: actorIsAgent ? null : input.actor.actorId,
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        if (comment) {
          await logActivity(txDb, {
            companyId: updated.companyId,
            actorType: input.actor.actorType,
            actorId: input.actor.actorId,
            agentId: actorIsAgent ? input.actor.actorId : null,
            runId: actorRunId,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: updated.id,
            issueId: updated.id,
            details: {
              commentId: comment.id,
              ...(actorIsAgent
                ? { authorAgentId: input.actor.actorId }
                : { authorUserId: input.actor.actorId }),
              source: "stalled_review_decision",
            },
          });
        }
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: actorIsAgent ? input.actor.actorId : null,
          runId: actorRunId,
          action: "issue.stalled_review_decided",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            status,
            identifier: updated.identifier,
            commentId: comment?.id ?? null,
            authorAgentId: comment && actorIsAgent ? input.actor.actorId : null,
            authorUserId: comment && !actorIsAgent ? input.actor.actorId : null,
            _previous: { status: lockedIssue.status },
          },
        });

        return { issue: updated, comment };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}
