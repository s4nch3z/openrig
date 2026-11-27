---
kind: as-built
title: Coordination Primitive — Stream/Queue/Inbox/Outbox
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator]
applies-when: |
  Need to know how the daemon-backed coordination primitive works — the
  stream/queue/inbox/outbox tables, the hot-potato closure contract, the
  transactional handoff guarantee, or where queue closure is enforced.
siblings: [workflow-runtime.md, mission-control.md, daemon-core.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Coordination Primitive — Stream/Queue/Inbox/Outbox

The coordination primitive is the SQLite-canonical durable-work layer the
daemon exposes through `/api/stream` and `/api/queue`. It replaces the POC
filesystem `rigx queue` / `rigx stream` path for daemon-backed work; the POC
filesystem path remains untouched, and the daemon-backed `rig queue` /
`rig stream` commands operate only through the daemon HTTP API, so they write
only to SQLite (`packages/cli/src/commands/queue.ts:19`,
`packages/cli/src/commands/stream.ts:11`).

> Verified against source at main `e8f0ab340db773392ec8be75b072d1c0f3068a50`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. The five host-scoped tables

Five host-scoped tables back the primitive, one per migration `023`–`027` in
`packages/daemon/src/db/migrations/` (**5** tables:
`cat packages/daemon/src/db/migrations/02[3-7]_*.ts | grep -c 'CREATE TABLE'`):

- **`stream_items`** (`023_stream_items.ts`) — L1 append-only intake/audit
  root. Columns: `stream_item_id` (TEXT PK; a ULID unless the caller supplies
  one, `packages/daemon/src/domain/stream-store.ts:88`), `ts_emitted`,
  `stream_sort_key`, `source_session`, `body`, `format` (default `text`),
  `hint_type`, `hint_urgency`, `hint_destination`, `hint_tags` (JSON),
  `interrupt`, `archived_at`, and `identity_provenance` (added by
  `067_i3_identity_provenance.ts`). Items immutable after emit (only
  `archived_at` may be set, `stream-store.ts:217`).
- **`queue_items`** (`024_queue_items.ts`) — L3 owned-work queue.
  Unless `--id` is supplied, the CLI generates the create request's `qitem_id` (TEXT PK) before sending as `qitem-<UTC YYYYMMDDHHMMSS>-<16 hex>` (64 random bits) and prints it to stderr as a request identity, not proof of persistence; reuse that ID with `--id` and the unchanged payload after an unknown outcome, while daemon callers without an ID still use `newQitemId()` and its `qitem-<UTC YYYYMMDDHHMMSS>-<8 hex>` form. `create --id-only` (alias `--quiet`) shortens that stderr line to `Request ID (unconfirmed): <id>` and prints the ID on stdout only when the daemon's reply names that same row.
  State enum (**8** values, `QUEUE_STATES` at `queue-repository.ts:33`;
  `sed -n '/^export const QUEUE_STATES/,/] as const/p' packages/daemon/src/domain/queue-repository.ts | grep -c '^  "'`):
  `pending | in-progress | done | blocked | failed | denied | canceled |
  handed-off`. Carries `closure_reason`, `closure_target`,
  `closure_required_at`, `chain_of_record` (JSON), `blocked_on`,
  `handed_off_to`/`handed_off_from`, nudge/heartbeat columns.
- **`queue_transitions`** (`025_queue_transitions.ts`) — L3 append-only
  transition log; authoritative audit trail for state evolution. Domain code
  never updates its rows. The one delete is the retention runner, which moves
  every transition of a terminal item whose last transition is older than the
  retention window into `queue_transitions_archive`
  (`054_queue_transitions_archive.ts`), insert and delete in one transaction
  (`packages/daemon/src/domain/queue-retention.ts:203`). Only `done` and
  `handed-off` items are archived; the default window is 30 days, and items
  still on a live workflow frontier are skipped (`queue-retention.ts:69`–`75`,
  `:158`–`171`).
- **`inbox_entries`** (`026_inbox_entries.ts`) — mailbox-style asynchronous
  deposit; idempotent on `inbox_id`. State: `pending | absorbed | denied`
  (`INBOX_STATES`, `inbox-handler.ts:5`).
- **`outbox_entries`** (`027_outbox_entries.ts`) — sender-side record;
  symmetric to inbox; idempotent on `outbox_id`. Delivery state (**7** values,
  `OUTBOX_DELIVERY_STATES` at `outbox-handler.ts:28`;
  `grep '^export const OUTBOX_DELIVERY_STATES' packages/daemon/src/domain/outbox-handler.ts | grep -o '"[a-z]*"' | wc -l`):
  `pending | sending | delivered | failed | indeterminate | retained |
  retired`.

These five are migrations `023`–`027` of the daemon's **96**
(`git ls-files packages/daemon/src/db/migrations | wc -l`), applied in the
order of `ALL_MIGRATIONS` (`packages/daemon/src/db/all-migrations.ts:107`).
Later migrations add columns to these tables; `daemon-core.md` covers the
migration set.

## 2. The six host-scoped services

Six host-scoped domain services in `packages/daemon/src/domain/` implement the
layer (**6** files:
`ls packages/daemon/src/domain/{stream-store,queue-repository,queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts | wc -l`).
Routes import these; services are Hono-free:

- **`stream-store.ts`** — L1 stream: idempotent emit (on `stream_item_id`),
  chronological list with cursor pagination plus source, destination, exact-tag,
  and inclusive time-window filters, soft archive. `direction=latest` applies
  every filter before taking the newest bounded page, then returns that page
  chronologically.
- **`queue-repository.ts`** — L3 queue: create (`:1391`), claim/unclaim
  (`:2186`, `:2271`), update (general state mutator with hot-potato
  strict-rejection on `done`, `:2334`), transactional handoff (close source as
  `handed-off` plus create new owned qitem in a single transaction, `:1656`;
  `handoffAndComplete`, `:1833`, closes the source as `done` instead),
  pod-fallback rerouting (`routeToFallback`, `:3678`), overdue lookup
  (`findOverdue`, `:3378`), nudge-result tracking (`recordNudgeAttempt`,
  `:3663`). Nothing in the daemon writes the `last_heartbeat` column
  (`queue-pickup.ts:16`). Cross-rig validation hook exposed as `validateRig`
  constructor option (`queue-repository.ts:717`).
- **`queue-transition-log.ts`** — append-only state-transition log; used by
  `queue-repository.ts`, exposed as the read-only property
  `QueueRepository.transitionLog` (`queue-repository.ts:666`).
- **`hot-potato-enforcer.ts`** — pure validator for the load-bearing API
  contract (see §3).
- **`inbox-handler.ts`** — mailbox handler: drop (idempotent on `inbox_id`,
  `:100`), absorb (promotes a pending entry to a `queue_item`, idempotent,
  `:155`), deny (records reason, `:215`). The handler has no auth hook
  (`inbox-handler.ts:71`); identity comes from the route. `POST /inbox/drop`
  takes the sender only from the `X-OpenRig-Session` header through
  `requireSenderIdentity` (`routes/queue.ts:1094`) and answers 400
  `actor_required` without it. Absorb and deny (`:1121`, `:1135`) use the
  header when present; otherwise they accept the body's `receiverSession` and
  record it as `claimed:v1` (`routes/require-sender-identity.ts:83`–`92`).
- **`outbox-handler.ts`** — sender-side outbox: idempotent record (`:130`),
  delivery-state marks (`markDelivered` `:239`, `markFailed` `:256`,
  `markIndeterminate` `:280`), list (`listForSender` `:339`). It also holds the
  queue's durable wake intents (ids prefixed `wake-intent-`, `:15`) and the
  messages the seat delivery guard retains (`retain` `:181`, `retire` `:217`),
  so it is not audit-only. Emits no event-bus events.

Create, handoff and handoff-and-complete return the committed row without
waiting for terminal delivery. Each stages a deterministic
`wake-intent-<qitem>` outbox row in its transaction and delivers it after
commit (`queue-repository.ts:1412`–`1424`, `:1475`–`1483`). The returned
`lastNudgeResult` is therefore normally null; `rig queue show <id>` reads the
wake result later. If create cannot retain the intent, the task is still saved
and the row records `failed:wake not retained: <reason>`. Startup reconciles
and drains intents left pending by a crash once (`startup.ts:2361`–`2362`).
`maybeNudge` remains only as the path for a repository with no outbox.

**What a wake carries.** (Renderer, typed delivery and copied-body reads checked
against `f2b2cafbdc95ac20d6471676ff70aebd81e96758`.) A wake to an agent
seat carries its row's body under the header (`renderQueueWakeBody`,
`queue-nudge-text.ts`), with a completeness line and an indented block. C0
controls other than newline, DEL and C1, invisible format characters, line and
paragraph separators and lone surrogates are shown escaped. The rendered block
is at most `QUEUE_WAKE_BODY_MAX_BYTES` (4096 bytes), indentation and escapes
included; a longer body is cut between whole characters and reads
`Body: preview; not automatically claimed`, followed by the full-read command.
An authored empty body is complete; an erased body is unavailable. Typed
coalesced sends include only their primary member's body; other members name
their rows and say the body was not included. Hook-bridge batches also retain
only their first body-carrying queue wake; omitted-body status is saved for
replay (`a1a6ca09d`, `HookBridge.poll` / `claimedBy`). Erasure scrubs stored wake copies;
seat reads of a copy whose queue row is absent omit its text with
`bodyHeld: qitem_unavailable` (`wakeCopyBodyGate`, queue and seat routes).

**A refused wake paste.** (Receiver records checked against `b4698289c`;
refusal paths against `20a879bc3bd751c08b281eef1958124418141f2d`.) Migration
`195_seat_input_residue` adds durable metadata records for a known queue-wake
paste whose Enter was not sent: the wake no longer applied, the binding changed,
another final check refused input, or the send threw before Enter. The original
result remains written; text is left in the input. An Enter that may have been
sent stays unconfirmed rather than being treated as a refused paste.
The records store the node, session, pane, observed pane PID, occupant and
outbox ID, never the body, and survive erasure of the outbox row. Receiver PIDs
are sampled around the paste. Every distinct sample retains its own hold,
including an unknown-process hold when a sample failed, so a later observation
cannot assign old bytes to a new receiver or replace another input's hold.

Before a later automatic paste or submit-only Enter,
`SessionTransport.inputResidueHold` reads the input. A typed input is held as
`draft_input_busy`; an unreadable one as `draft_input_unknown`. Nothing is
automatically removed. Positive empty-input evidence permits the send; it
clears only the record matching the known current pane PID. A different known
pane PID permits that receiver's send while retaining the old process's hold,
unless an unknown-process hold also applies. Tenure or pane-label drift alone
does not release it. Unknown-process records remain conservative: an empty
input permits a send without clearing that record. Explicit deliberate
interaction bypasses this automatic-input hold.

**Claim on wake.** (Checked against
`a1a6ca09d682219d264fa70f429bca7ac6e55e70`.) Migration
`196_queue_claim_on_wake` adds
`queue_items.claim_on_wake` (default 0) and the nullable
`claim_wake_outbox_id` / `claim_wake_transition_id`. A row created or handed
off with `claimOnWake` (never inherited by a handoff) renders
`CLAIMED_BY_WAKE_LINE` only in wakes with a durable intent: `stageWakeIntent`
(create, handoff successor) and fallback dispatch. Ladder
and retry text keeps the manual claim line. `claimForWake` claims at the final
handover and nowhere earlier: for a typed paste or native offer in
`SendOpts.beforeOwnPayload` (`tmux.ts` `sendTextUnchecked`, `admitNative`),
after every guard; for the hook bridge inside the poll's batch transaction, one
savepoint per member, before the hook gets the batch. `claimRow` holds the
claim's checks and transaction, and subscribers hear of it only after the
outermost commit. Both routes then run their final checks again, since a
subscriber may change the seat: a typed refusal there reads
`draft_wake_superseded`; a bridge member that no longer applies ends not
delivered, and from the first held one the rest go back to the queue untaken.
`giveBackWakeClaim` undoes only that wake's own claim, while it is the row's
newest transition, on positive no-input evidence: `writtenFact` none with no
live native offer, or a bridge member never handed over. A wake's claim skips
relay pickup; the row's `claimWakeOutboxId`, `create --verify`, the write
receipt and the stuck sweep say the claim was the wake's, not the seat's. The
background drain stays pending-only, so a crash never re-delivers a
wake-claimed row, and a replayed bridge batch whose claim is gone is marked
uncertain rather than handed out. Refused before anything is written: a
person's destination (`claim_on_wake_unsupported_destination`), a write for
another host (`claim_on_wake_cross_host_unsupported`), and a same-ID retry
that changes the policy (409 `qitem_claim_on_wake_conflict`).

Stable has no per-task activation or conversation guard in this path; these
claims use the existing seat/occupant delivery authority. The supported queue
transfer is staging-only. Its unchanged v2 format omits the local policy and
claim-correlation columns; staging grants no live delivery authority.

**Which field answers "did it reach them".** `deliveryOutcome` is the gateway
(human-delivery) ledger, derived at read time
(`QueueRepository.deliveryOutcomeFor`): `posted` or `transport-failed` from the
row's Slack receipt notes, or `never-posted` when a gateway-routed row still
has no receipt once the post window has passed. A task delivered only to an
agent's pane has no such receipt, so it reads `null`. A task that also has a
gateway or human-notification side can carry a value, and the CLI then reports
that gateway side too. For the pane side, read:

- `lastNudgeWireResult`: the wake send's result as stored (for example
  `verified`, `delivered-ack-pending`, `indeterminate:…`, `retained:…`,
  `failed:…`). A claim never rewrites it; a later wake replaces it. Each stored
  form reads as one delivery fact (`readWakeOutcome`, `connection-contract.ts`).
  A result no reader recognises reads `unknown`, never delivered: the wake ladder
  treats it as an unconfirmed wake, which escalates past the window without a
  re-send.
- `lastNudgeResult`: the result as presented. A manually claimed row whose
  stored result is `delivered-ack-pending` or `indeterminate:…` reads `claimed`
  (`presentedNudgeResult`). A row with `claimWakeOutboxId` keeps the wire result:
  the wake's automatic claim does not confirm delivery. Unclaiming shows the
  stored result again.
- `claimedAt`: when a claim was recorded for the destination. Closing doesn't
  clear it. `claimWakeOutboxId` identifies a claim made by that wake rather than
  a manual pickup by the seat; neither origin proves the body was read.
- `pickup`: the derived pickup receipt (`unclaimed`, `working`, `needs-input`,
  `stalled-after-claim`, `parked`, `terminal`), computed at read time.

A claimed item whose owner's activity reports outstanding input reads
`needs-input`, with the reason in `pickup.evidence`. That covers an item in
progress and a `pending` item that kept its claim, after an update back to
`pending` or a reopen. A Codex permission request the daemon couldn't confirm on
screen reads `owner may need input (not verified: permission_request_unverified)`.
The input signal can outlast the prompt it reported, so it never pauses
recovery. When the claim would otherwise read `stalled-after-claim`, the receipt
keeps that evidence in `pickup.stall`, and the stuck sweep's finding, its
backstop and manual dispositions behave exactly as for `stalled-after-claim`.
Queue reads, the pickup view and the execution view share this receipt
(`queue-pickup.ts`). Unclaimed, blocked and terminal items keep their receipts.

A manual claim isn't proof that the body was read or that the terminal render
was verified, and closing a task isn't a new delivery receipt. The manual-claim
shortcut still presents an unconfirmed wire result as `claimed` and tells
`create --verify` that the seat took the item. A wake-origin claim takes no such
shortcut: `--verify` keeps the wake's own outcome and any unresolved next action,
and explains that the claim was the daemon's, not evidence of the seat taking or
reading the work (`terminalDeliveryResult`, `packages/cli/src/commands/queue.ts`).
The derived `pickup` classification may still read `working` from claim age;
it is not additional delivery proof for a wake-origin claim.

The standing detector in `queue-stuck-sweep.ts` creates findings through the
queue repository, with `evidenceRef: rig queue show <source-qitem-id>` pointing
to the underlying durable work row. Unclaimed and undelivered findings go to
the destination's orchestrator when one is derivable, otherwise to the
destination itself, and that seat may be dead. A wake that failed (`failed:…`)
at a recorded agent seat with no `delegates_to` parent or `escalates_to` route is
the exception: its finding tries the row's creator, then the operator agent
(`agents.operator_session`), skipping an unset, confirmed-missing, self or
unaccepted address, a bound terminal seat, and OpenRig's own machinery
(`daemon@kernel` or a `@system` actor), so the finding's own wake isn't sent to the seat that just failed to
take one. If neither can be used, it stays with the original seat and says why.
When this failed-wake route sends the finding back to a creator who is a person (their answer or ask waits on a live
agent seat that couldn't take a wake), it reaches them as a notice from OpenRig: an update (`humanIntent: update`) from
`stuck-sweep@system` at the person's own address, titled with the seat it waits for, saying nothing in it is theirs to
do. The other routes back to a creator (no wake route, a terminal seat, a missing seat) tell the person to act and stay
asks. When the person's address can't be read, the finding is written as before.
Overdue claims go to their destination. Repeated detections reuse the existing finding without changing
its route; when the source condition resolves, the sweep closes its own finding.
Previously, falling out of a reporting query could itself close a delivery or
unclaimed finding. An unconfirmed retry, a fresh human-notification post window,
an unreadable human registry or a larger reporting-age setting could therefore
look like successful recovery. These findings now require source evidence:
closure, pickup or parking of the work, a verified/accepted wake, or a posted
notification for the current human recipient and episode, as appropriate to the
finding. `delivered-ack-pending`, `indeterminate:…`, missing results and unrelated
legacy human receipts do not prove resolution. Uncertainty keeps an existing
finding open without itself sending another wake or creating another finding.
A verified wake resolves a wake failure, not an unclaimed obligation: delivery
does not prove pickup. A wake-origin claim alone also cannot resolve an
undelivered-wake finding: it is recorded before delivery, so the sweep still
requires separate delivery or manual-pickup evidence (`bada72674`,
`deliveryResolutionEvidence`). Other obligation kinds keep their existing
claim/closure semantics.

A legacy human notice with no owner-notification history can still resolve from
the existing item-scoped posted ledger when its recipient is confirmed human.
This covers older pending asks and parks without inventing an episode that was
never recorded. A registered alias needs a readable registry to establish its
human recipient; reserved human references remain known during an outage.
Legacy receipts carry no recipient key, so a destination reroute requires a new
matching notification episode. A legacy park is accepted only when no earlier
notice or reroute predates it, and later history contains only receipts or
asking-agent reroutes within that park. A re-park, an exit from the park or an
ambiguous append cannot establish the same recipient without owner history;
the finding waits for a new matching episode or other source resolution.
Rerouting only the asking agent within an otherwise unchanged park preserves
its human recipient (`blockedOn`).
Modern notifications still require their current episode, and an unrelated
legacy human receipt cannot resolve an agent wake.

A known hold still leaves recovery with the existing mechanism: an ask on
Steering without an alert, a wake held by the seat typing guard, or a live
quiet-release job. Its closure note names that disposition rather than claiming
delivery or pickup. An unreadable quiet hold is not positive closure evidence.
Claimed work in either `pending` or `in-progress` uses the same pickup derivation;
returning a row to `pending` while retaining its claim no longer hides a later
stall or closes its existing stalled-claim finding. A retained failed wake cannot
override that pickup evidence. The agent's claim still does not establish delivery
of a separate notification to a person.

That automatic closure records `stuck-sweep@system` as the actor in both the
transition and the `queue.updated` audit event, with the source evidence in the
delivery and unclaimed-obligation closure notes. Previously it credited the finding's source agent
with the detector's action. The finding's source,
destination and claim remain its existing ownership records; the underlying work
is not reassigned, and existing transition history is not rewritten.

`queue-stuck-sweep-resolution.test.ts` checks unconfirmed retries, retained
claims, current human-notification episodes and registry outages with migrated
SQLite, including positive recovery controls and no repeated send on an
unresolved retry. `quiet-hold-custody.test.ts` checks existing findings with
readable and unreadable quiet custody. `queue-stuck-sweep.test.ts` checks that
pending and claimed findings close once, name the sweep in their transition and
event, and keep their ownership. The posted-human-notice case also checks the actor while leaving
the person's original ask open. These checks exercise the detector and queue
repository, not a live agent or connector.

The sweep reports six finding kinds. Its custody check covers closures that
name a successor qitem or a seat (`closure_reason = handed_off_to`) in the last
24 hours, plus older closures with open findings. A seat target is satisfied by
a local successor carrying this row's lineage, and any target by a
`custody-verified:` note on the closed row: per note, its first word that names one
of the row's targets exactly (or a comma list of them) is what it verifies, and later
mentions don't count; the finding prints each target's note. A new custody finding for
a human destination goes to the agent that closed the item, using the closing
transition from active or archived history. Later notes and notification
receipts do not change that owner. If the closing actor is missing, human, system
machinery or not admitted by this host's queue, the asking agent receives the
finding if its address is admitted. Human identity includes reserved references
and registered aliases, independent of terminal bindings. Admission uses the
queue's existing address check and does not require a live seat. An agent
destination keeps its existing route; if neither closer nor source is an admitted
agent, the human destination remains the durable fallback. This routing does not
change custody verification or suppress unresolved findings.

If the human registry is unavailable when a custody candidate's owner needs
classification, that candidate keeps its original destination, and one log line
per candidate names it and the registry error. This doesn't infer an agent
identity from an unreadable registry, which may not exist before the first human
is registered. In a pass with no finding to save for a `<name>@external` person,
which includes an install with no registry yet, work bound for agents keeps
routing and repaired findings still close. Such a finding still needs the
registry to admit it when it's saved, so during an outage a pass that must save
one fails at that finding, as it did before this routing. Findings not yet
created in that pass, and the closing of repaired findings, wait for the next
pass that completes. Once the registry can be read again, the next pass creates
the finding and routes it to the closer. Registry recovery restores owner refinement
for new findings; existing findings keep their established route. Reserved human
references and legacy agent names keep their known classifications without a
registry read.

## 3. The hot-potato closure contract (where queue closure is enforced)

`hot-potato-enforcer.ts` is the pure validator for the load-bearing API
contract. `validateClosure` (`hot-potato-enforcer.ts:59`) checks a transition
against `CLOSURE_REASONS` (`:18`; **7** values:
`sed -n '/^export const CLOSURE_REASONS/,/] as const/p' packages/daemon/src/domain/hot-potato-enforcer.ts | grep -c '^  "'`):

`state=done` requires `closure_reason ∈ {handed_off_to, denied,
canceled, no-follow-on, escalation, superseded}`. The reasons
`handed_off_to | escalation` additionally require
`closure_target` (`:86`):

- `handed_off_to` — work continues with a different seat (`closure_target` =
  new owner). `rig queue show` on such a row names the row the handoff made in
  `successors` (rows whose `handedOffFrom` is this row, and a local row its
  closure target names), or says in `successorNote` why none is named. A
  cross-host successor is named as recorded (`<id>@<host>`); nothing stored
  changes. Past 20 such rows the newest 20 are named, with
  `successorsTruncated: true`. A scoped MCP caller doesn't get these fields;
  `rig_queue_show`'s scope-checked `successor` answers it instead.
- `blocked_on` — an active `state=blocked` park record, rejected with `state=done`.
  To wait for a qitem, use `rig queue block <id> --on <child>` or
  `rig queue update <id> --state blocked --blocked-on <child>`; the item returns
  to pending when its blocker completes.
- `denied` — receiver rejected the work (`closure_target` = reason text).
- `canceled` — sender or receiver withdrew (`closure_target` = note).
- `no-follow-on` — terminal completion, nothing else needed.
- `escalation` — kicked up to a higher tier (`closure_target` = escalation
  target).
- `superseded` — the row was replaced by cancel-and-replace
  (`closure_target` = the successor qitem). The update path records it on
  `state=canceled` and refuses it there without a `closure_target`
  (`queue-repository.ts:2629`).

Tier→SLA mapping for `closure_required_at` also lives in
`hot-potato-enforcer.ts` (`TIER_SLA_SECONDS`, `:115`). This validator is
invoked by `QueueRepository.update()` (and `updateWithinTransaction()`), both
through the call at `queue-repository.ts:2531`, so closure is enforced at the
daemon transaction boundary — the workflow runtime *projects* on closure but
does not otherwise gate it (see `workflow-runtime.md`). The one
workflow-aware check is in the queue: `update()` refuses a terminal close of a
live workflow frontier packet from a non-workflow verb
(`workflow_frontier_packet`, `queue-repository.ts:2557`), through a predicate
startup injects. "Terminal" there is the queue's terminal set, `done` and
`handed-off` (`queue-repository.ts:52`).

Closure fields are stored only on `state=done`, the park record (`blocked`
with `blocked_on`), the handoff close (`handed-off` with `handed_off_to`) and
the superseded cancel; any other transition carrying them is refused with
`closure_fields_not_admitted`, and `blocked_on` outside `blocked` with
`blocked_on_not_admitted`. A `done`, `canceled` or `handed-off` row accepts a
note without a state change as an append-only transition; moving it to
another state requires an explicit reopen with a note. A `qitem-` blocker must
exist and be live on this daemon; when a blocker leaves the active states,
each row parked on it follows the blocker's handoff successor or returns to
`pending` with a durable wake (`queue-repository.ts:2407`–`2529`,
`:2612`–`2656`, `:2931`–`3008`). Claiming a parked row clears its
`blocked_on`; the claim transition keeps the former gate as a `closure_target`
audit pointer with no closure reason, which a re-park without `--blocked-on`
reuses (`queue-repository.ts:2233`–`2254`, `:2571`–`2577`).
`human-route-enforcer.ts` is a second pure validator at the same boundary: a
`human-gate` row, a row addressed to a human seat, or a park on one must carry
`summary` and `evidence_ref`.

## 3b. Cross-host queue routing

Three queue write routes are host-aware — `POST /create`,
`POST /:qitemId/handoff` and `POST /:qitemId/handoff-and-complete` (**3**:
`grep -c '!resolvesToLocalHost(body.hostId, getSelfHostId())' packages/daemon/src/routes/queue.ts`):
a write body may carry an out-of-band `hostId` envelope. The destination
session stays `member@rig`; the 3-part `agent@rig@host` form is CLI input
sugar that `resolveQueueHostDestination`
(`packages/cli/src/commands/queue.ts:394`) splits into the destination and
`hostId` before the request leaves the CLI. The same split applies to
`--host <id>`; queue verbs never follow `rig host select`, and naming two
different hosts is refused with `host_qualifier_conflict`. The mechanism
follows the forward-then-strip shape of mission-control's remote action
(`routes/mission-control.ts:352`): one shared route-layer helper
(`forwardQueueWrite`, `routes/queue.ts:214`) resolves the host registry
daemon-side (bearers never reach the caller), rejects ssh-declared hosts
(`unsupported-transport` — the daemon→daemon path is http-only), and forwards
the whole body, with `hostId` stripped, via `remoteJsonRequest` (`:248`) under
a named write-class deadline (`QUEUE_FORWARD_TIMEOUT_MS`, `:41`). The origin's
response returns verbatim; failures map to a structured host-named error
(`remote_queue_write_failed`, HTTP 502, `:234`) whose `failureClass` is one of
registry / unknown-host / unsupported-transport / unreachable / auth-failed /
remote-error. No local row is ever written on the cross-host path.

**The model: origin-owns-the-record, at-least-once + idempotent,
message-passing closure (never 2PC).**

- **Origin-owns-the-record.** The qitem lives in the TARGET host's DB; that
  row is THE record. The target daemon wakes the destination on ITS local
  tmux: its own `create` stages a durable wake intent and delivers it after
  commit (§2; the forwarded body carries the `nudge` flag) — the sending
  daemon never reaches across a host boundary. Before forwarding, the
  forwarding daemon stamps its own host id, when it has one, onto the source
  session (`stampSelfHostSuffix`, `queue-repository.ts:548`; called at
  `routes/queue.ts:378` and `:509`), so the target row records the sender as
  `member@rig@<forwarding host>`.
- **Idempotency.** On create, the forwarding daemon mints the `qitemId` before
  the forward unless the caller supplied one (`routes/queue.ts:501`). The
  forward is a single request, so a retry dedups only when it carries the same
  id (a caller re-sending `--id`, or a handoff re-drive, whose successor id is
  derived). Dedup rides the existing `qitem_id TEXT PRIMARY KEY`. On PK
  conflict the origin returns the stored row when destination and source
  match (idempotent absorb) and a structured `qitem_id_reuse` error (409) when
  they differ (`QueueRepository.create()` catch path,
  `queue-repository.ts:1431`–`1472`, with `isQitemPrimaryKeyConflict`,
  `:461`). When destination and source match but the body differs, the stored
  row is returned unchanged with `createWarning: qitem_body_not_saved`; the
  supplied body is not saved (`:1450`–`1454`).
- **Cross-host handoff choreography.** The local atomic close+create cannot
  span two DBs, so the route-layer choreography (`crossHostHandoff`,
  `routes/queue.ts:316`) runs: successor-create on the target host FIRST (via
  the one forward helper, `:397`), local source-close SECOND
  (`QueueRepository.closeCrossHostHandoffSource`, `queue-repository.ts:2031`)
  — never the reverse. A crash between the two leaves a live duplicate that
  the idempotent re-drive converges; the reverse order would leave a closed
  source pointing at a successor that does not exist (a dropped potato — the
  one forbidden outcome). The successor id is DERIVED, not minted:
  `deriveCrossHostSuccessorId(source, destination, host)`
  (`queue-repository.ts:489`) → `qitem-xh-<sha256[:16]>` — a pure stateless
  function, so a re-drive re-derives the same id across daemon restarts and
  absorbs on the target PK. *(Residual, inherent to at-least-once delivery
  without 2PC: a re-drive naming a DIFFERENT destination derives a different
  id and cannot absorb the earlier successor — that orphan stays visible via
  the chain + provenance tags; the source-close conflict check surfaces the
  disagreement.)*
- **Closure across the boundary.** The source closes with
  `closure_reason=handed_off_to` and
  `closure_target=<successor qitem id>@<host>` (`routes/queue.ts:351`); a
  source already closed with the older `member@rig@<host>` target keeps it,
  and a re-drive matches against it (`:352`–`356`). `closure_target` is OPAQUE
  audit metadata, never parsed for routing; the standing stuck sweep reads it
  only to check successor custody (`queue-stuck-sweep.ts:519`–`554`). The
  host-qualified key appears only in the `closure_target` column on
  `queue_items` and its verbatim mirror on `queue_transitions`: the minted
  cross-host close note names the 2-part `toSession` only
  (`queue-repository.ts:2087`), and `handed_off_to` and the
  `queue.handed_off` event stay 2-part.
  Re-drive semantics: already-terminal + MATCHING `closure_target` = absorb;
  MISMATCH = structured `cross_host_close_conflict` (409), checked in the route
  before any forward (`routes/queue.ts:359`) and again in the repository. The
  successor carries `chain_of_record = [...source.chain, source.qitemId]`
  (`routes/queue.ts:384`) — A-side ids are opaque lineage identifiers on B
  (they do not dereference in B's DB) — plus provenance tags `cross-host` +
  `from-host:<self-declared name>` (the forwarding daemon's OS hostname,
  `routes/queue.ts:54`; honest best-effort, not authenticated identity).
- **Boundary discipline.** Claim, update and inbox routes take no `hostId` and
  stay local (after a cross-host handoff the successor lives where its worker
  lives). Without a `hostId`, with `local`, or with this daemon's own resolved
  host id (an exact, case-sensitive match), create and handoff take the
  local path; a self-addressed handoff whose deterministic cross-host
  successor an earlier self-forward already created runs that cross-host
  create and close in process. The
  hot-potato validation contract (§3) is unweakened across the boundary: the
  cross-host close always records `handed_off_to` with a target.

## 4. Coordination events

The `RigEvent` union (`packages/daemon/src/domain/types.ts:108`) has **98**
members
(`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`);
this module covers only the coordination families below.

Coordination events emitted by these services: `stream.emitted`
(`StreamStore.emit`, declared at `types.ts:245`); `queue.created` /
`queue.handed_off` / `queue.claimed` / `queue.unclaimed` / `queue.updated` /
`qitem.fallback_routed` / `qitem.closure_overdue` (QueueRepository); `inbox.absorbed` (`types.ts:255`) /
`inbox.denied` (InboxHandler). `qitem.closure_overdue` (`types.ts:254`) is
emitted by `QueueRepository.recordClosureOverdue` when swept by `queue-stuck-sweep`
and passed through the queue watch filter (**2** files contain its literal:
`git grep -l -F 'type: "qitem.closure_overdue"' -- packages/daemon/src | wc -l`).
The `stream|queue|inbox|qitem` families declare **10** event types (`stream` 1
+ `queue` 5 + `inbox` 2 + `qitem` 2;
`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"(stream|queue|inbox|qitem)\.[a-z_]+"' | sort -u | wc -l`).

Two SSE surfaces stream coordination events (**2**:
`cat packages/daemon/src/routes/stream.ts packages/daemon/src/routes/queue.ts | grep -c 'return streamSSE('`):
`/api/stream/watch` (aliased `/api/stream/sse`, `routes/stream.ts:194`–`195`),
which first replays up to 50 unarchived items in chronological order (the
oldest, `:174`–`181`) and then streams new items, and `/api/queue/watch`
(aliased `/api/queue/sse`, `routes/queue.ts:1054`–`1055`) for queue/inbox
events — every coordination type except `stream.emitted` and `queue.updated`
(filter at `routes/queue.ts:1031`–`1038`). The event log remains append-only and
SQLite-backed. `rig stream watch` is a thin, single-connection consumer of
`/api/stream/sse` (`packages/cli/src/commands/stream.ts:191`); it does not add
a daemon route or reconnect policy.

## 5. Route surface

The TUI FEED reads `/api/attention` for human requests and current explicit
human-addressed updates. Its independent update query filters open states and
strict human destinations before the 1001-row sentinel, serves at most 1000
updates with critical then urgent rows first, and requires no transport receipt. These local
FYIs create no approval obligation. `/api/queue/human-updates` remains confirmed
delivery history; the TUI suppresses a history card when the same queue item is
in the current update window. Current-update coverage is independent of the
receipt window, so an unavailable current reader cannot retain closed delivery
history beyond a successful history read. Both reads leave queue state intact.

Clients that need only current FYIs can use `GET /api/queue/open-human-updates`.
It returns `{items, limit, truncated}` with open human-addressed updates, ordered
critical then urgent then routine, without requiring a delivery receipt. `limit`
defaults to 20 and accepts integers from 1 to 100. Optional `view` follows the
same person perspective as `/api/attention`; a perspective read scans at most
1000 rows and signals `truncated` when the window may omit matching items.

A finished item's result file is its `evidenceRef`, read through the daemon's
shared roots with `rig_artifact_read` (MCP) or `rig queue artifact <qitemId>
--json` (CLI). For a code result, the assignee writes a JSON file of kind
`openrig.code-result/v1`, with `repo` (an absolute path or a URL), `base` and
`revision` (full commit ids, SHA-1 or SHA-256), and optionally `paths`, `branch`
and `fetch: {remote, ref}`. Both reads then add `codeResult`, the exact pair a
client can diff. A manifest whose base or revision isn't a full commit id gets
`codeResultIssue` instead. `branch` and `fetch` are hints for finding the commits,
never the revision. Other files read as before.

- `/api/stream` (`server.ts:783`) — `POST /emit` (`routes/stream.ts:56`),
  `GET /list` (`:91`, including `sourceSession`, `hintDestination`, `hintTag`,
  `since`, `until` and `direction` filters), `GET /watch` + `/sse` SSE
  (`:194`), `GET /:streamItemId` (`:198`), `POST /:streamItemId/archive`
  (`:207`).
- `/api/queue` (`server.ts:784`) — `POST /create` (`routes/queue.ts:450`),
  `POST /:qitemId/claim` (`:545`), `POST /:qitemId/unclaim` (`:561`),
  `POST /:qitemId/update` (`:600`), plus handoff (`:650`, `:732`),
  `POST /:qitemId/fallback` (`:808`), list (`:902`) and watch (`:1054`)
  surfaces; reads `GET /whoami`, `/attention-aggregate`, `/human-updates`,
  `/overdue`, `/undelivered`, `/recent-transitions`, `/:qitemId/transitions`
  and `/:qitemId` (`:822`–`1067`); inbox routes `POST /inbox/drop`,
  `/inbox/:id/absorb`, `/inbox/:id/deny` and `GET /inbox/pending`,
  `/inbox/list` (`:1076`–`1152`); outbox routes `POST /outbox/record` and
  `GET /outbox/list` (`:1161`, `:1190`).

Every write route derives its actor through `requireSenderIdentity`
(`routes/require-sender-identity.ts:76`): the `X-OpenRig-Session` header wins
over a body actor. On a direct request from a known origin it is recorded as
`transport:v1`; `resolveRecordedProvenance` (`:199`) instead records
`origin-unknown:v1` when the origin-unknown marker is set or a relayed request
carried `origin-unknown:v1` (`:207`), `relay:v1` for a relayed request that
carried `transport:v1`, and `claimed:v1` for other relayed requests. `transport:v1`
says the name came from that header, which the CLI sets from the seat's
`OPENRIG_SESSION_NAME`; it isn't an authentication. Without the
header, the
body actor is recorded as `claimed:v1`; with neither (or, for inbox drop,
without the header) the route answers 400 `actor_required`. The stamp lands in
`identity_provenance` on transitions, inbox, outbox and stream rows
(migrations `067`, `082`).

## See also

- `daemon-core.md` — daemon wiring, the migration set, route surface.
- `workflow-runtime.md` — the workflow runtime that projects on closure.
- `mission-control.md` — queue observability over `queue_items`.
- Source roots: `packages/daemon/src/domain/{stream-store,queue-repository,
  queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`,
  `packages/daemon/src/routes/{stream,queue}.ts`.
