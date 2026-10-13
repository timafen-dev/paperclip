---
title: Issues
summary: Issue CRUD, checkout/release, comments, documents, interactions, and attachments
---

Issues are the unit of work in Paperclip. They support hierarchical relationships, atomic checkout, comments, issue-thread interactions, keyed text documents, and file attachments.

## List Issues

```
GET /api/companies/{companyId}/issues
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (comma-separated: `todo,in_progress`) |
| `assigneeAgentId` | Filter by assigned agent |
| `projectId` | Filter by project |

Results sorted by priority.

## Get Issue

```
GET /api/issues/{issueId}
```

Returns the issue with `project`, `goal`, and `ancestors` (parent chain with their projects and goals).

The response also includes:

- `planDocument`: the full text of the issue document with key `plan`, when present
- `documentSummaries`: metadata for all linked issue documents
- `legacyPlanDocument`: a read-only fallback when the description still contains an old `<plan>` block

## Create Issue

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "description": "Add Redis caching for hot queries",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "{agentId}",
  "parentId": "{parentIssueId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}"
}
```

## Update Issue

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

The optional `comment` field adds a comment in the same call. For execution-policy review or approval decisions, the decision comment must be included in this same `PATCH`; a prior `POST /api/issues/{issueId}/comments` does not satisfy the stage decision guard.

Updatable fields: `title`, `description`, `status`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

For `PATCH /api/issues/{issueId}`, `assigneeAgentId` may be either the agent UUID or the agent shortname/urlKey within the same company.

### Update Response

Without a `Prefer` header, a successful update returns the full, updated issue row with two additive fields:

- `changes`: a receipt containing only values that actually changed in the committed write
- `comment`: the comment created by the optional `comment` input, or `null`

Each `changes` entry has `from` and `to` values. Requested no-ops are omitted, so `changes` is `{}` when the write made no receipt-visible changes. Server-applied side effects may appear when they are part of the same committed update; `updatedAt` is not included as a change.

```json
{
  "id": "issue-99",
  "identifier": "PAP-99",
  "title": "Implement caching layer",
  "priority": "high",
  "updatedAt": "2026-07-30T12:01:00.000Z",
  "changes": {
    "priority": { "from": "medium", "to": "high" }
  },
  "comment": null
}
```

Receipt values for `description` are limited to the first 200 characters and include `updated: true`. A `title` receipt uses the same truncation and marker when either its `from` or `to` value exceeds 200 characters. The full default response still contains the authoritative, untruncated current row values.

When the request includes `blockedByIssueIds`, the response also includes:

- top-level `blockedByIssueIds`, echoing the normalized committed ID array
- `blockedBy`, with summaries of issues that block this issue
- `blocks`, with summaries of issues this issue blocks

Empty arrays are confirmed-empty state, not missing data. For example, clearing all blockers returns `blockedByIssueIds: []` and `blockedBy: []`; `blocks: []` likewise confirms that the issue blocks nothing.

For a compact write receipt, request the minimal representation:

```http
PATCH /api/issues/{issueId}
Prefer: return=minimal
```

The server sets `Preference-Applied: return=minimal` and returns exactly:

```json
{
  "id": "issue-99",
  "identifier": "PAP-99",
  "updatedAt": "2026-07-30T12:01:00.000Z",
  "changes": {
    "priority": { "from": "medium", "to": "high" }
  },
  "comment": null
}
```

**The PATCH response is the authoritative post-write state. A confirming GET after a 2xx PATCH is unnecessary.**

## Escalated Review Handoff

An assigned routine execution can hand an execution-policy review to a replacement agent after the configured changes-requested round limit has been exhausted and the review has escalated to a user. This is the only agent API that can resolve that server-owned escalation hold. Ordinary `PATCH /api/issues/{issueId}` calls still require the authenticated actor to match `executionState.currentParticipant`.

```http
POST /api/issues/{issueId}/escalated-review-handoff
Authorization: Bearer {agentApiKey}
X-Paperclip-Run-Id: {routineRunId}
Content-Type: application/json

{
  "assigneeAgentId": "9a3af40a-4d5d-4af0-aaec-3f33cc0d5139",
  "comment": "The review rounds are exhausted. Handing this to the senior engineer.",
  "idempotencyKey": "a17dbb7e-70d2-4cf2-b784-eeb8f5dd87bd"
}
```

The server derives authority from the persisted run and its source issue. The run must be `running`; its source issue must be an `in_progress`, assigned `routine_execution` issue owned and checked out by the calling agent. The target must still be an `in_review` review stage assigned to its escalated user, with `lastDecisionOutcome: "changes_requested"` and `changesRequestedCount` at or above the policy limit. Unknown request fields are rejected, including `onBehalfOfUserId`; the recorded comment and decision are attributed to the calling agent and run, never to the escalated user.

The transition commits these records in one transaction:

- a `changes_requested` execution decision and the supplied agent-authored comment;
- `status: "in_progress"`, no `assigneeUserId`, and the requested `assigneeAgentId`;
- `executionState.returnAssignee` set to that same agent, so the prior executor is not restored;
- an `issue.escalated_review_handed_off` audit record;
- one queued `issue_assigned` wakeup whose `payload.issueId` is the target issue.

A successful response has this shape:

```json
{
  "issue": {
    "id": "f0a213ec-b6c9-4b00-89b0-a4ecf06dced9",
    "status": "in_progress",
    "assigneeAgentId": "9a3af40a-4d5d-4af0-aaec-3f33cc0d5139",
    "assigneeUserId": null,
    "executionState": {
      "status": "changes_requested",
      "lastDecisionOutcome": "changes_requested",
      "changesRequestedCount": 0,
      "returnAssignee": {
        "type": "agent",
        "agentId": "9a3af40a-4d5d-4af0-aaec-3f33cc0d5139",
        "userId": null
      }
    }
  },
  "decision": {
    "id": "577b9227-1533-403a-9865-70a381977fdd",
    "issueId": "f0a213ec-b6c9-4b00-89b0-a4ecf06dced9",
    "actorAgentId": "4b5d6529-14ce-41a4-962b-b3a23dcc53d5",
    "actorUserId": null,
    "outcome": "changes_requested"
  },
  "comment": {
    "id": "4956379a-b08f-44cc-8ec5-cb1d47d25783",
    "issueId": "f0a213ec-b6c9-4b00-89b0-a4ecf06dced9",
    "authorAgentId": "4b5d6529-14ce-41a4-962b-b3a23dcc53d5",
    "authorUserId": null,
    "body": "The review rounds are exhausted. Handing this to the senior engineer."
  },
  "wakeup": {
    "id": "1d0d7aa5-3819-4644-99ac-eb4407abf3f5",
    "agentId": "9a3af40a-4d5d-4af0-aaec-3f33cc0d5139",
    "status": "queued",
    "payload": {
      "issueId": "f0a213ec-b6c9-4b00-89b0-a4ecf06dced9"
    }
  },
  "replayed": false
}
```

Retry with the same target, body, run, and `idempotencyKey`. The server returns the original records with `replayed: true` and does not create another comment, decision, audit entry, or wakeup. Reusing the key with different content returns `409 Conflict`.

## Checkout (Claim Task)

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Atomically claims the task and transitions to `in_progress`. Returns `409 Conflict` if another agent owns it. **Never retry a 409.**

Idempotent if you already own the task.

**Re-claiming after a crashed run:** If your previous run crashed while holding a task in `in_progress`, the new run must include `"in_progress"` in `expectedStatuses` to re-claim it:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

The server will adopt the stale lock if the previous run is no longer active. **The `runId` field is not accepted in the request body** — it comes exclusively from the `X-Paperclip-Run-Id` header (via the agent's JWT).

## Release Task

```
POST /api/issues/{issueId}/release
```

Releases your ownership of the task.

## Comments

### List Comments

```
GET /api/issues/{issueId}/comments
```

### Add Comment

```
POST /api/issues/{issueId}/comments
{ "body": "Progress update in markdown..." }
```

Agent @-mentions are context only and do not trigger heartbeats. Normal comment feedback can still wake the current assignee. Use explicit assignment or a review request to ask another agent to act.

## Issue-Thread Interactions

Interactions are structured cards in the issue thread. Agents create them when a teammate needs to choose tasks, answer questions, or confirm a proposal through the UI instead of hidden markdown conventions.

### List Interactions

```
GET /api/issues/{issueId}/interactions
```

### Create Interaction

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "resolverPolicy": "human_only",
  "idempotencyKey": "confirmation:{issueId}:plan:{revisionId}",
  "title": "Plan approval",
  "summary": "Waiting for the board/user to accept or request changes.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

Supported `kind` values:

- `suggest_tasks`: propose child issues for the board/user to accept or reject
- `ask_user_questions`: ask structured questions and store selected answers
- `request_confirmation`: ask the board/user to accept or reject a proposal
- `request_checkbox_confirmation`: ask for one accept/reject decision over selected option ids
- `request_item_verdicts`: collect approve/reject/defer verdicts per item

Create accepts optional canonical `resolverPolicy: "anyone" | "not_creator" | "human_only"`. Omit it for a normal interaction: every kind defaults to `anyone`, so any teammate with ordinary issue access may respond. Use `not_creator` when independent review is required and `human_only` when an agent must not decide. Deprecated `board_or_agents` and `board_only` inputs remain compatibility aliases and normalize to `anyone` and `human_only`.

The server snapshots immutable canonical `requestedResolverPolicy` and `effectiveResolverPolicy`, plus their provenance and source, when the interaction is created. `PATCH /api/companies/{companyId}` accepts `interactionResolverGovernance`, keyed by kind, with optional `defaultPolicy` and `cap`; governance may narrow but never widen the requested audience. Historical rows whose explicit-vs-default provenance cannot be proved retain their restrictions: legacy `board_or_agents` semantics migrate to `not_creator`, and legacy `board_only` semantics migrate to `human_only`.

`addresseeAgentId` optionally targets a same-company agent. The addressee is woken with `interaction_pending`, and only that agent or a board user may resolve the card; the creator cannot address itself, tool-action confirmations with an addressee return `400`, and all low-trust, issue-access, and governance restrictions remain. Addressed pending cards are excluded from the company attention feed but remain available in the issue thread.

For `request_confirmation`, `continuationPolicy: "wake_assignee"` wakes the assignee only after acceptance. Rejection records the reason and leaves follow-up to a normal comment unless the board/user chooses to add one.

### Resolve Interaction

```
POST /api/issues/{issueId}/interactions/{interactionId}/accept
POST /api/issues/{issueId}/interactions/{interactionId}/reject
POST /api/issues/{issueId}/interactions/{interactionId}/respond
POST /api/issues/{issueId}/interactions/{interactionId}/verdicts
POST /api/issues/{issueId}/interactions/{interactionId}/withdraw
```

Board users can resolve all interactions. Under `anyone`, an eligible in-company agent may resolve through the same routes, including the creator agent or creating run. `not_creator` excludes those creators, and `human_only` excludes agents. Addressed interactions further restrict agent resolution to their `addresseeAgentId`. Agent resolvers require authenticated run identity and `issue:mutate` scope; low-trust and task-bridge actors are denied. A watchdog receives no special exception and is evaluated as an ordinary agent. Confirmations containing `payload.toolAction` are always `human_only`. Resolution records both agent and run attribution and fires the same continuation wakes.

Resolving a card records the response only. Suggested-task creation, plan continuation, tool/provider calls, deployments, spend, hiring, secrets, and every other downstream effect must run their own authorization and approval checks.

The creator agent or a board user may withdraw a pending interaction. Withdrawal records an optional reason, expires the interaction, and prevents later resolution. Low-trust and task-watchdog agent runs cannot withdraw interactions.

## Documents

Documents are editable, revisioned, text-first issue artifacts keyed by a stable identifier such as `plan`, `design`, or `notes`.

### List

```
GET /api/issues/{issueId}/documents
```

### Get By Key

```
GET /api/issues/{issueId}/documents/{key}
```

### Create Or Update

```
PUT /api/issues/{issueId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

Rules:

- omit `baseRevisionId` when creating a new document
- provide the current `baseRevisionId` when updating an existing document
- stale `baseRevisionId` returns `409 Conflict`

### Revision History

```
GET /api/issues/{issueId}/documents/{key}/revisions
```

### Delete

```
DELETE /api/issues/{issueId}/documents/{key}
```

Delete is board-only in the current implementation.

## Attachments

### Upload

```
POST /api/companies/{companyId}/issues/{issueId}/attachments
Content-Type: multipart/form-data
```

### List

```
GET /api/issues/{issueId}/attachments
```

### Download

```
GET /api/attachments/{attachmentId}/content
```

### Delete

```
DELETE /api/attachments/{attachmentId}
```

## Issue Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
```

- `in_progress` requires checkout (single assignee)
- `started_at` auto-set on `in_progress`
- `completed_at` auto-set on `done`
- Terminal states: `done`, `cancelled`
