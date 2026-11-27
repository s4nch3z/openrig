# Queue wakes that carry the work

Status: implemented contribution for review, based on upstream **v0.7.23**
(`484cbffb071575941c7392eb5487b011cd86bb13`).

This feature has its own branch, `feat/queue-wake-body-stable`. It does not
depend on the experimental per-task session or compaction implementation.
The original design was written before implementation; this document records
the selected design and its stable implementation. Release labeling and an
upstream submission remain separate from this contribution.

## Problem and outcome

A queue wake currently names a row and its summary. The receiving agent often
needs another `queue show` call to read the work, followed by `queue claim`
before it starts. Creating a row also prints a larger receipt when a script
only needs the persisted ID.

The change provides three behaviors:

1. A wake carries a bounded, clearly labeled copy of the row body.
2. A sender can explicitly opt a local row into claiming at the moment its
   complete-body wake is handed to the recipient.
3. `queue create --id-only` (alias `--quiet`) prints one confirmed row ID on
   stdout, while preserving request identity and recovery diagnostics.

Default claims stay manual. The design introduces no new provider turn,
background replay loop or cost-saving guarantee.

## Body format and budget

The existing sender, recipient, time, row ID and summary envelope stays in
place. The body section reports whether it is complete, a preview, unavailable
after erasure, or omitted from a batch. For example:

```text
Queue handoff: qitem-example - check your queue. Summary: Review the patch
Body: complete
Claim: required — rig queue claim 'qitem-example'
    Review the patch and report any regression.
```

An opted-in complete wake instead says:

```text
Claim: claimed for this seat by this wake; no rig queue claim needed
```

The rendered body block has a **4,096-byte UTF-8 budget**, including indentation
and escape expansion. Every line is indented four spaces, so authored `---`,
`From:` or `Reply:` lines remain body data. Unsafe controls, including tabs,
DEL/C1, invisible format characters and unpaired surrogates, are visibly
escaped. A cut never splits a Unicode code point or escape. Stored body bytes
are not rewritten by rendering.

A preview includes a shell-quoted `rig queue show ID --full` command and is
never automatically claimed. An authored empty body can be complete; erased
content is unavailable, not a successful empty body.

Each typed coalesced delivery or hook-bridge batch carries **one primary body**
under that same budget. Existing path ordering chooses the primary. Other
rows have metadata and full-read/manual-claim instructions, and are not
automatically claimed. The change does not split a batch into extra turns.

## Snapshot, erasure and final checks

The existing durable wake intent freezes its rendered payload and association
with the original queue row. Erasure scrubs the row and associated outbox
copies. Queue-wake copy reads respect erasure too.

Delivery rechecks applicability at each write boundary. A canceled, settled,
erased or no-longer-applicable row cannot authorize a stale body merely because
the body was rendered earlier. A possibly written or uncertain payload is
not refreshed under its original delivery receipt.

Stable v0.7.23 has no experimental task-frame custody APIs. This branch uses
stable recipient and delivery checks; it does not import those APIs or claim
their additional guarantees.

## Explicit claim on wake

`--claim-on-wake` and API/MCP `claimOnWake` are explicit per-row options, default
false. A handoff does not inherit the source row's option. A no-nudge create
does not claim merely by being stored.

Eligibility requires a pending, unexpired, unblocked row addressed to the
actual recipient and a complete primary body in the admitted wake. The normal
claim transaction is reused. Automatic ownership is recorded as wake-origin
ownership rather than a recipient relay pickup.

The claim happens at one of three existing delivery boundaries:

- **Typed input:** immediately before this wake's own paste, after guards.
  Earlier or repeated validation calls do not claim, and a previous leftover
  Enter cannot claim the new wake.
- **Native offer:** immediately before the admitted offer, with the same
  recipient and correlation checks.
- **Hook bridge:** inside the leased poll/batch transaction, before handing
  the body to the hook. Acknowledgment settles the original delivery receipt;
  it does not create the claim.

Subscriber notification occurs after the outer transaction commits. The
recipient, row and payload applicability are checked again after notification,
because a subscriber can change them.

The row records `claim_wake_outbox_id` and `claim_wake_transition_id`. Repeated
checks must match that exact wake and claim transition. A later unclaim,
manual reclaim or recipient change does not grant an old wake new authority.

Rollback requires **positive no-input evidence** and the same untouched newest
claim transition. A failed return alone is insufficient. Written or uncertain
input, and an already persisted native offer, retain the claim. An automatic
claim alone is not evidence that the seat read the work: receipts, `--verify`
and the stuck sweep distinguish ownership from delivery.

The background drain remains pending-only. Crash recovery does not resend an
automatically claimed wake just because no acknowledgment arrived. Existing
reconciliation remains responsible for uncertain outcomes.

## Stable prerequisite: preserve a refused paste

Final checks can refuse Enter after a queue wake has already pasted its text.
Without a hold, the next automatic send could append to that text and submit
the refused work. This branch adds a narrow durable hold for that case.

The hold stores receiver metadata, never a body copy: node, session, pane,
pane process, occupant, outbox ID and time. It records every distinct sampled
receiver, including an unknown process. Multiple receivers do not overwrite
each other's holds. Erasing an outbox payload does not erase this evidence.

Later automatic input to the affected receiver reads its composer first.
Nonempty or unreadable input stays held with an explicit diagnostic. A positive
empty read permits the next send. A distinct known process can receive its own
input while the old process's hold remains; tenure or pane-label changes alone
do not release a hold. Unknown process evidence stays conservative.

No destructive key or automatic text removal is added. The person or seat can
clear the composer; the next automatic send verifies emptiness. A possibly
sent Enter retains its uncertain receipt instead of becoming a no-input hold.
Ordinary sends do not acquire this hold without a known refused queue-wake
paste. Existing deliberate interaction behavior remains unchanged.

## Persistence and compatibility

- Migration **195**, `seat_input_residue`, adds the metadata-only hold table.
- Migration **196**, `queue_claim_on_wake`, adds default-off claim policy and
  nullable wake/transition correlation columns. Existing rows stay manual.
- CLI create, handoff and handoff-and-complete, HTTP and supported MCP
  producers carry the explicit policy.
- Same-ID retries with a different policy return HTTP 409
  `qitem_claim_on_wake_conflict`; they do not change or redeliver the row.
- Human/gateway and cross-host opt-in destinations are refused before
  forwarding. Default cross-host/manual behavior is preserved.
- An older endpoint that stores a row but drops the requested flag produces
  `claim_on_wake_not_kept`: same known ID, error exit, no success stdout. It
  does not authorize another create with a new ID.
- Stable's staging-only queue transfer format remains unchanged. It omits
  local claim policy and does not enable imported live claims or outboxes.

## ID-only creation and interrupted requests

`queue create --id-only` and `--quiet` are aliases. They cannot combine with
`--json` or `--full`. Normal output stays unchanged.

Before POST, stderr prints a short `Request ID (unconfirmed): ID` line. Only a
confirmed same-request persisted row produces `ID\n` on stdout. A killed
process can therefore leave the original retry identity even if stdout is
empty. Callers that discard stderr should supply an explicit `--id`.

Missing or mismatched successful replies, ambiguous HTTP errors and lost
responses retain full same-ID reconciliation guidance on stderr. Empty stdout
does not prove that nothing was created. A changed-policy conflict or ignored
flag never prints a false success ID.

`--verify` still reports delivery separately. Confirmed persistence with
unresolved requested delivery verification retains the existing exit-zero
policy, prints the persisted ID and reports the unresolved receipt on stderr.
An ID is not a delivery receipt.

## Documentation and implementation map

The contribution updates CLI help, the public capability guide, the CLI
reference, the queue-handoff and openrig-user skills, and the coordination
architecture document. Main implementation owners are:

- `queue-nudge-text.ts`: bounded escaping, completeness and claim text.
- `queue-repository.ts`: snapshot applicability, claim transaction and wake
  correlation; `queue-stuck-sweep.ts`: ownership/delivery distinction.
- `session-transport.ts`, `draft-aware-delivery.ts` and `tmux.ts`: final own
  payload boundary, no-input evidence and refused-paste hold.
- `hook-bridge.ts`: leased claim and one-primary batch handover.
- CLI `commands/queue.ts`, `queue-receipt.ts` and `mcp-server.ts`: public flags,
  policy propagation and truthful create receipts.

No package version, lock file or CHANGELOG changes are included. Maintainers
own release labels. Reverting code does not remove database migrations or
metadata already written; this contribution supplies no downgrade procedure.

## Verification and remaining limits

Implementation tested at
`30218a285b3b3a0f4fbacb4a6e6544c5d1079289`; the later addition of this design
document changes no executable code. Environment: macOS arm64, Node 22.23.3.

Fresh build and selected end-to-end QA passed **31/31**: compiled CLI 12,
private tmux text composer 10, typed stub 5 and real bridge/routes/waiter 4.
The checks cover preview/escaping, exact body effects, erasure after paste,
restart-preserved holds, claim timing, one-primary batches, lost acknowledgment
and same-ID recovery. Source and documentation received independent review.

The full `npm test` run **exited 1**:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| Repository checks | 415 | 0 |
| Daemon | 32,900 | 1 |
| CLI | 7,791 | 2 |
| TUI | 1,388 | 0 |

The two CLI `busy-daemon-auto-start` blocked-health-probe assertions also fail
on untouched, freshly built v0.7.23. The daemon
`claude-executable-foreground` wrapper fixture timed out in the full run but
passes 30/30 alone on both candidate and stable. Its full-run cause remains
unknown. These qualifications are not an all-green CI claim.

Build, lint, repository checks and the separate UI suite were also run during
the contribution; UI passed 1,843 tests with one skip before later non-UI
changes. Tests use private daemons, stubs, a text composer and controlled
adapter effects. They do not prove live provider parsing or a percentage of
billing savings. The branch is for maintainer review, not a published release.
