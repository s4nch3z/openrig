// Claim on wake, typed and native: a wake whose text carries an opted-in row's whole body claims that row immediately
// before its own paste or offer (not at an earlier check), and only the primary row of a coalesced delivery. A claim
// whose wake then provably wrote nothing is given back; a drain never sends a row its wake claimed again. Real migrated
// SQLite, queue, outbox, transport, tmux adapter and delivery guard; the tmux executor only records commands.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { RunnerChannel } from "../src/domain/runner-channel.js";
import { CLAIMED_BY_WAKE_LINE, QUEUE_WAKE_BODY_MAX_BYTES, renderQueueHandoffNudge, renderQueueWakeBody } from "../src/domain/queue-nudge-text.js";
import { wakeBody } from "../src/domain/queue-repository.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";

type RowSpec = { body: string; claimOnWake?: boolean; expiresAt?: string };

async function fixture(rows: RowSpec[], opts: { native?: boolean } = {}) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'occupant-1','fresh');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@test','running');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const outbox = new OutboxHandler(db);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true,
    loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const created = [];
  for (const spec of rows) created.push(await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", ...spec }));
  const ids = created.map(r => r.qitemId);
  const state = (id: string) => (db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(id) as { state: string }).state;
  let loaded = "";
  const pasted: string[] = [];
  const atLoad: string[] = [], atPaste: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    const line = String(command);
    const buffer = /load-buffer .* '([^']+)'$/.exec(line);
    if (buffer) { loaded = readFileSync(buffer[1]!, "utf8"); atLoad.push(state(ids[0]!)); }
    if (line.includes("paste-buffer")) { pasted.push(loaded); atPaste.push(state(ids[0]!)); }
    return "";
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
  let channel: RunnerChannel | undefined;
  const cleanup: Array<() => void> = [];
  if (opts.native) {
    const grants = new ActivityGrantStore(db);
    const grant = grants.issue({ nodeId: "a", generation: "occupant-1", issuedBy: "launch",
      run: { runId: "run-1", binding: { runtime: "claude-code", runner: 1, pane: "%1", panePid: 10 } } });
    grants.activate(grant.grantId);
    channel = new RunnerChannel(grants, outbox);
    channel.post(grant.token, { type: "hello", version: 1, runId: "run-1", retained: true, capabilities: { input: true, wake: true, cancel: false } });
    cleanup.push(channel.connect(grant.token));
    new RigRepository(db).setNodeInputRoute("a", "native");
  }
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    sleep: async () => {}, ...(channel ? { runnerChannel: channel } : {}) } as never);
  repo.attachTransport(transport);
  const correlation = (id: string) => db.prepare("SELECT claim_wake_outbox_id AS outboxId, claim_wake_transition_id AS transitionId FROM queue_items WHERE qitem_id = ?").get(id) as
    { outboxId: string | null; transitionId: number | null };
  const notes = (id: string) => (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id").all(id) as Array<{ transition_note: string }>).map(t => t.transition_note);
  const raw = (id: string) => (db.prepare("SELECT last_nudge_result FROM queue_items WHERE qitem_id = ?").get(id) as { last_nudge_result: string | null }).last_nudge_result;
  const done = () => { for (const c of cleanup) c(); db.close(); vi.restoreAllMocks(); };
  return { db, bus, repo, outbox, ids, state, pasted, atLoad, atPaste, channel, correlation, notes, raw, done };
}

describe("claim on wake, typed and native", () => {
  it("the typed route claims an opted-in row at its paste, not before, and says so in the text", async () => {
    const f = await fixture([{ body: "CLAIM-ME", claimOnWake: true }]);
    try {
      await f.repo.drainPendingWakeIntents();
      expect(f.atLoad).toEqual(["pending"]);
      expect(f.atPaste).toEqual(["in-progress"]);
      expect(f.pasted).toHaveLength(1);
      expect(f.pasted[0]).toContain(CLAIMED_BY_WAKE_LINE);
      expect(f.pasted[0]).toContain("CLAIM-ME");
      const correlation = f.correlation(f.ids[0]!);
      expect(correlation.outboxId).toMatch(/^wake-intent-/);
      expect(f.notes(f.ids[0]!)).toEqual(["created", "claimed"]);
      // The wake's own claim isn't the seat's: the unconfirmed wire result isn't presented as claimed.
      expect(f.raw(f.ids[0]!)).toBe("delivered-ack-pending");
      expect(f.repo.getById(f.ids[0]!)?.lastNudgeResult).toBe("delivered-ack-pending");
      expect(f.repo.getById(f.ids[0]!)?.claimWakeOutboxId).toBe(correlation.outboxId);
      const event = f.db.prepare("SELECT payload FROM events WHERE type = 'queue.claimed'").get() as { payload: string };
      expect(JSON.parse(event.payload).wakeOutboxId).toBe(correlation.outboxId);
    } finally { f.done(); }
  });

  it("a row without the opt-in, or whose body is only previewed, isn't claimed", async () => {
    const f = await fixture([{ body: "PLAIN" }, { body: "x".repeat(QUEUE_WAKE_BODY_MAX_BYTES + 10), claimOnWake: true }]);
    try {
      await f.repo.drainPendingWakeIntents();
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted.join("\n")).not.toContain(CLAIMED_BY_WAKE_LINE);
      expect(f.ids.map(f.state)).toEqual(["pending", "pending"]);
    } finally { f.done(); }
  });

  it("a coalesced delivery claims only its primary row; the other is named, and its claim stays manual", async () => {
    const f = await fixture([{ body: "FIRST", claimOnWake: true }, { body: "SECOND", claimOnWake: true }]);
    try {
      // Wakes returning to the same row go as one delivery (a returned result and its resume).
      f.db.prepare("UPDATE outbox_entries SET tags = ? WHERE audit_pointer IN (?, ?)").run(JSON.stringify(["queue:return:qitem-shared"]), f.ids[0], f.ids[1]);
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted).toHaveLength(1);
      expect(f.pasted[0]).toContain(`Claim: required — rig queue claim '${f.ids[1]}'`);
      expect(f.pasted[0]!.split(CLAIMED_BY_WAKE_LINE)).toHaveLength(2);
      expect(f.ids.map(f.state)).toEqual(["in-progress", "pending"]);
    } finally { f.done(); }
  });

  it("a drain doesn't send a row its wake claimed again, even with that wake's entry left pending (a crash)", async () => {
    const f = await fixture([{ body: "ONCE", claimOnWake: true }]);
    try {
      await f.repo.drainPendingWakeIntents();
      const { outboxId } = f.correlation(f.ids[0]!);
      f.db.prepare("UPDATE outbox_entries SET delivery_state = 'pending' WHERE outbox_id = ?").run(outboxId);
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted).toHaveLength(1);
      expect(f.state(f.ids[0]!)).toBe("in-progress");
    } finally { f.done(); }
  });

  it("the native route claims at its offer; an offer that provably wrote nothing gives the claim back", async () => {
    const offered = await fixture([{ body: "NATIVE", claimOnWake: true }], { native: true });
    try {
      const admit = vi.spyOn(offered.channel!, "admit");
      await offered.repo.drainPendingWakeIntents();
      expect(admit).toHaveBeenCalledTimes(1);
      expect(offered.state(offered.ids[0]!)).toBe("in-progress");
      expect(offered.correlation(offered.ids[0]!).outboxId).toMatch(/^wake-intent-/);
    } finally { offered.done(); }

    const rejected = await fixture([{ body: "NATIVE", claimOnWake: true }], { native: true });
    try {
      let stateAtOffer = "";
      vi.spyOn(rejected.channel!, "admit").mockImplementation((_node, entry) => {
        stateAtOffer = rejected.state(rejected.ids[0]!);
        return { requestId: entry.outboxId, stage: "rejected" } as never;
      });
      await rejected.repo.drainPendingWakeIntents();
      expect(stateAtOffer).toBe("in-progress");
      expect(rejected.state(rejected.ids[0]!)).toBe("pending");
      expect(rejected.correlation(rejected.ids[0]!)).toEqual({ outboxId: null, transitionId: null });
      expect(rejected.notes(rejected.ids[0]!)).toEqual(["created", "claimed", "unclaimed: the wake that claimed it wrote no input"]);
    } finally { rejected.done(); }

    // The channel stored the offer, then a change listener threw: the send's result lost it, the offer is still live.
    const lost = await fixture([{ body: "NATIVE", claimOnWake: true }], { native: true });
    try {
      let threw = false;
      lost.channel!.subscribe(() => { if (!threw) { threw = true; throw new Error("listener failed"); } });
      await lost.repo.drainPendingWakeIntents();
      expect(threw).toBe(true);
      expect(lost.state(lost.ids[0]!)).toBe("in-progress");
      expect(lost.notes(lost.ids[0]!)).toEqual(["created", "claimed"]);
      expect(lost.outbox.runnerReceipt(lost.correlation(lost.ids[0]!).outboxId!)?.stage).toBe("pending");
    } finally { lost.done(); }
  });

  it("an expired row isn't claimed, and its claimed line isn't written", async () => {
    const f = await fixture([{ body: "LATE", claimOnWake: true, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    try {
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted).toEqual([]);
      expect(f.state(f.ids[0]!)).toBe("pending");
      expect(f.notes(f.ids[0]!)).toEqual(["created"]);
    } finally { f.done(); }
  });

  it("a row a claim subscriber moves on at once (cancels) doesn't get the wake's text", async () => {
    const f = await fixture([{ body: "CANCEL-ME", claimOnWake: true }]);
    try {
      f.bus.subscribe((event) => {
        if (event.type === "queue.claimed") void f.repo.update({ qitemId: event.qitemId, actorSession: "sender@test", state: "canceled", transitionNote: "no longer wanted" });
      });
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted).toEqual([]);
      expect(f.state(f.ids[0]!)).toBe("canceled");
    } finally { f.done(); }
  });

  it("a claim subscriber that changes the seat (its pane) stops the wake: the checks run again after the claim", async () => {
    for (const native of [false, true]) {
      const f = await fixture([{ body: "MOVED", claimOnWake: true }], { native });
      try {
        const admit = native ? vi.spyOn(f.channel!, "admit") : null;
        f.bus.subscribe((event) => {
          if (event.type === "queue.claimed") f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE id = 'b'").run();
        });
        await f.repo.drainPendingWakeIntents();
        expect(f.pasted, `native ${native}`).toEqual([]);
        if (admit) expect(admit).not.toHaveBeenCalled();
        // Nothing was written, and nothing else touched the row, so the wake's claim is given back.
        expect(f.state(f.ids[0]!), `native ${native}`).toBe("pending");
        expect(f.notes(f.ids[0]!)).toEqual(["created", "claimed", "unclaimed: the wake that claimed it wrote no input"]);
      } finally { f.done(); }
    }
  });

  it("a wake with no durable entry (the ladder's own render) never says claimed, and claims nothing", async () => {
    const f = await fixture([{ body: "LADDER", claimOnWake: true }]);
    try {
      const id = f.ids[0]!;
      // Settle the create's own wake first, then send as the wake ladder composes its text.
      await f.repo.drainPendingWakeIntents();
      f.repo.unclaim(id, "worker@test", "test");
      f.pasted.length = 0;
      const row = f.repo.getById(id)!;
      await f.repo.maybeNudge(id, "worker@test", true, OPENRIG_SENDER, `${renderQueueHandoffNudge(id, null)}\n${renderQueueWakeBody(id, wakeBody(row))}`, "openrig");
      expect(f.pasted).toHaveLength(1);
      expect(f.pasted[0]).toContain("LADDER");
      expect(f.pasted[0]).not.toContain(CLAIMED_BY_WAKE_LINE);
      expect(f.pasted[0]).toContain(`Claim: required — rig queue claim '${id}'`);
      expect(f.state(id)).toBe("pending");
    } finally { f.done(); }
  });

  it("a manual claim clears an earlier wake's correlation", async () => {
    const f = await fixture([{ body: "AGAIN", claimOnWake: true }]);
    try {
      await f.repo.drainPendingWakeIntents();
      f.repo.unclaim(f.ids[0]!, "worker@test", "test");
      f.repo.claim({ qitemId: f.ids[0]!, destinationSession: "worker@test" });
      expect(f.correlation(f.ids[0]!)).toEqual({ outboxId: null, transitionId: null });
      expect(f.repo.getById(f.ids[0]!)).not.toHaveProperty("claimWakeOutboxId");
      // A manual claim is the seat acting, which presents the unconfirmed wire result as claimed again (#165).
      expect(f.raw(f.ids[0]!)).toBe("delivered-ack-pending");
      expect(f.repo.getById(f.ids[0]!)?.lastNudgeResult).toBe("claimed");
    } finally { f.done(); }
  });
});
