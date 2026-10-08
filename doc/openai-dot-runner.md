# OpenAI Dot with Paperclip Runner

OpenAI Dot is an experimental provider of `paperclip_runner`. A dedicated
agent OAuth connection and MCP Events wake an existing Dot. The Rust Runner
owns the assignment lifecycle and durable tool receipts. Dot uses Paperclip's
existing agent permissions and task tools, including document writes and
completion feedback.

This first version supports a self-hosted instance with a local Runner
controller and a stable public HTTPS origin. Hosted agent-broker and remote
controller deployments are not qualified. The feature is off by default.

## Enable and pair

1. Configure `PAPERCLIP_PUBLIC_URL` to the instance's stable HTTPS origin and
   enable Public MCP and Paperclip Runner in experimental settings. Set
   `PAPERCLIP_ENABLE_OPENAI_DOT=1` on the server.
2. Create an approved Paperclip Runner agent with provider **OpenAI Dot**.
   Acknowledge that its provider billing is external and unmetered. Save it.
3. In the agent configuration, choose **Pair Dot**. Connect a private ChatGPT
   plugin to the displayed `/mcp/runner` URL and approve its dedicated agent
   OAuth scope. The personal `/mcp/paperclip` connection cannot execute as Dot.
4. Give the Dot the one-use pairing code. It calls `paperclip_dot_pair`, then
   subscribes to `paperclip.dot.mailbox_updated` with the returned company and
   binding IDs. Its callback must pass the signed webhook verification.
5. Choose **Test event delivery**. Dot drains `paperclip_dot_inbox` and confirms
   the readiness challenge. Readiness requires this round trip, not just an
   HTTP acknowledgement from the callback.
6. Assign a task to the agent. Normal scheduling, checkout, company access,
   budgets and approval rules still determine admission.

Only the operator's one-use pairing code is displayed. OAuth tokens and callback
signing secrets stay on the server and never enter the Runner descriptor,
task prompt or saved adapter config. Pairing codes expire after 15 minutes.

The dedicated connection uses the merged MCP gateway's PKCE browser and device
flows, including verified client metadata documents and organization hints.
Its issuer is `<origin>/mcp/runner/oauth`; the personal issuer remains `<origin>`.
The shared consent page identifies Dot agent access and requires an operator
role. Device codes and browser requests stay bound to their original resource
and organization. The gateway's Connections invitations remain personal
assistant invitations; use the agent's Dot connection panel for Runner pairing.

Database migration `0317_messy_famine.sql` adds only Dot tables and extensions
after the merged gateway migrations. It is safe to reapply. The earlier
prototype migration number is retired; published master migrations are intact.

## Assignment protocol

Events contain mailbox references. Dot drains the inbox after its saved cursor,
reads the assignment, and explicitly accepts it before executing tools. A
webhook `2xx` does not mean Dot accepted or started the task. Duplicate or
out-of-order events must not create another assignment.

Dot invokes catalogued tools through `paperclip_dot_tool`. Every operation uses
a UUID request ID. A pending response is reconciled with
`paperclip_dot_operation_status` or retried with **the same ID and arguments**.
Changing arguments under the same ID is rejected. An unknown write must never
be retried under a new ID.

Dot calls `paperclip_finish` or `paperclip_block` through the tool bridge, then
ends the external turn with `paperclip_dot_finish` using exactly the accepted
structured report. Paperclip's ordinary result and status finalizers decide
the task disposition. Dot can also discover its assigned tasks and request
normal admission with `paperclip_dot_tasks` and `paperclip_dot_request_work`.

The completion tool returns its canonical accepted report. The final turn can
repeat either that canonical report or the exact original accepted arguments;
the Runner persists and emits the canonical report. Changed reports are rejected.
Work requests use a durable admission receipt keyed by binding, generation and
request ID. Retries read that receipt, even after a task finishes, and cannot
enqueue another run or move the same request to another task. A Dot runs one
assignment at a time; competing tasks stay queued regardless of the agent's
configured concurrency. During setup the connection panel continues checking
for a verified event subscription without requiring a manual refresh.
Mailbox writers and cursor reads serialize through the binding row so a cursor
cannot skip a tool result whose transaction commits later. A paused Dot can
receive fence notices and acknowledge them, but cannot read tasks or execute
tools; those narrow inbox reads leave its task cursor unchanged.

## Limits and recovery

- One active assignment per binding. Acceptance expires after 10 minutes;
  execution authority expires after two hours. Fifteen minutes without useful
  activity is shown in the connection panel as requiring attention.
- No mounted workspace, selectable model, native Dot thread identifier,
  provider usage or provider cost. Text deliverables use Paperclip documents.
  Assigned skill files and third-party MCP bindings are currently unsupported
  and fail admission explicitly.
- Cancel, pause, reassignment and revocation fence Paperclip authority. They do
  not confirm that Dot stopped all external activity. A fence acknowledgement
  records receipt only.
- Controller recovery restores the same bridge and assignment. A missing or
  invalid advertised checkpoint requires reconciliation. Automatic bounded
  retries do not create replacement Dot assignments. A tool effect still in
  flight when its controller detaches stays pending if its exact outcome was
  not durably recorded; recovery does not execute that write again.
- Keep the public origin stable. Subscriptions expire and must be renewed;
  reconnection drains current mailbox references rather than claiming event
replay. Disabling new Dot work does not grant old assignments new authority.

Resubscribing verifies the Dot callback again and publishes a fresh mailbox
reference for its existing outstanding assignment. It does not create another
assignment or replay tool effects. OAuth revocation and refresh-token replay
also revoke the matching binding, fence its assignments, and cancel waiting
Paperclip runs. Revoking an old grant cannot revoke a replacement binding.
Reopening an agent form restores the binding reference from the server so a
previously completed pairing can still be saved in the agent configuration.

## Verification evidence

`server/src/__tests__/dot-runner.test.ts` uses an isolated PostgreSQL database,
real Rust Runner, dedicated PKCE OAuth, a signed synthetic callback, normal
semantic authority, a document write and the ordinary status finalizer. It
checks duplicate writes, changed-argument rejection, membership loss and
revocation. Runner tests cover bridge reattachment, missing checkpoints,
closed launch fields, expiry and late effect receipts after fencing.

The earlier real-Dot account experiment proved OAuth and signed wake/report
transport through the reference harness; see `dot-runner-prototype.md`. That
proof does not qualify this new dedicated endpoint against a real account.
The dedicated adapter's account acceptance test remains to be run. The new
connection UI has passed compilation and token gates; it has not yet received
a hands-on browser acceptance test.

Local verification on 2026-10-03:

| Check | Result |
| --- | --- |
| `pnpm -r typecheck`, `pnpm build`, UI token gates | Passed |
| Rust workspace library tests | 312 passed |
| PRP schema tests and CI shard selection tests | 13 and 24 passed |
| Control-plane and Dot driver regression tests | 97 passed, including late callback retirement |
| Real Rust / PostgreSQL Dot integration | 2 passed |
| Agent configuration route tests | 36 passed, including unpaired create and conversion |
| Stable shared package lane | 837 passed |
| Adapter utilities and Codex adapter source tests | 1,883 passed, 12 skipped |
| Root `pnpm test:run` attempt | Server group: 744 files passed, 2 failed, 4 skipped; 14,997 tests passed. Wrapper stopped at that failed group. |

The root run's failures were a Calendar socket reset and a Git scan load
assertion (497 of 498 expected joined requests). Both failing cases passed in
isolation. A subsequent stable database lane passed 126 tests but failed one
embedded PostgreSQL startup; that test also passed in isolation. These results
do not establish a completely green repository suite or release readiness.

Gateway integration on 2026-10-06 merged master through `c365a16e3`, including
the released browser/device consent and assistant invitations (#14846 and
#14933). Initial integration verification passed full workspace typecheck and
build, token gates, 125 gateway/consent/admission tests, five Dot integration
tests, 20 consent/Connections UI tests, 318 Rust library tests, 123 Runner/Dot
recovery tests and 13 PRP schema tests.

The local root `pnpm test:run` was stopped after 2 hours 47 minutes when review
fixes made it stale; it did not complete and is not a passing result. Fresh
PR CI verifies the final branch. The review fixes cover reconnect wakeups,
OAuth disconnect and refresh replay, binding-reference restoration, board-only
OpenAPI coverage and prior protocol-version assumptions. Current results and
remaining qualification are tracked in [PR #15402](https://github.com/paperclipai/paperclip/pull/15402).

After those fixes, full workspace typecheck and token gates passed again.
Focused verification passed 89 gateway, Dot, OpenAPI, connection-instruction
and pairing UI tests, 40 protocol/runtime compatibility tests, and the real
Runner protocol-upgrade/replacement test.

PR CI exposed a clean-shutdown race: Rust could exit after the durable shutdown
receipt was acknowledged but before the Dot SDK's next poll. The adapter now
recognizes that confirmed clean exit and still requires reconciliation after
an unexpected exit. A real Rust regression reproduces the failing order and
passes with the fix. Four driver tests and 11 integration/pairing tests passed,
including a failed connection refresh after successful revocation. Revocation
clears the cached binding before refetch so that failure cannot restore it.

Visual review uses the production `DotRunnerConnection` component in the
`Assistant connections/Dot Runner` Storybook stories. Pairing, event-test
waiting and revocation were exercised in the browser with synthetic API
responses. These screenshots show preview data, not a qualified Dot account:

![Synthetic pairing preview](screenshots/openai-dot-runner/pairing.jpg)

![Synthetic connected preview](screenshots/openai-dot-runner/connected.jpg)
