// Independent real domain/transport/adapter seam controls. The executor records tmux commands only.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, wakeBody } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { RunnerChannel } from "../src/domain/runner-channel.js";
import { CLAIMED_BY_WAKE_LINE, renderQueueHandoffNudge, renderQueueWakeBody } from "../src/domain/queue-nudge-text.js";

async function fixture(expiresAt?: string, native = false, afterPaste?: (db: Database.Database) => void) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'g1','fresh');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@test','running');`);
  const bus = new EventBus(db), outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const row = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "ORIGINAL-WORK", claimOnWake: true, expiresAt });
  let loaded = "", pane = "";
  const pasted: Array<{ text: string; state: string }> = [];
  const submitted: string[] = [];
  const atLoad: string[] = [];
  const state = () => repo.getById(row.qitemId)!.state;
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const tmux = new TmuxAdapter(async command => {
    const line = String(command), buffer = /load-buffer .* '([^']+)'$/.exec(line);
    if (buffer) { loaded = readFileSync(buffer[1]!, "utf8"); atLoad.push(state()); }
    if (line.includes("paste-buffer")) { pasted.push({ text: loaded, state: state() }); pane += loaded; afterPaste?.(db); }
    if (line.includes("send-keys") && line.includes("Enter")) submitted.push(pane);
    return line.includes("capture-pane") ? pane : "";
  });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
  let channel: RunnerChannel | undefined, disconnect: (() => void) | undefined;
  if (native) {
    const grants = new ActivityGrantStore(db);
    const grant = grants.issue({ nodeId: "a", generation: "g1", issuedBy: "launch", run: { runId: "run-review", binding: { runtime: "claude-code", runner: 1, pane: "%1", panePid: 10 } } });
    grants.activate(grant.grantId);
    channel = new RunnerChannel(grants, outbox);
    channel.post(grant.token, { type: "hello", version: 1, runId: "run-review", retained: true, capabilities: { input: true, wake: true, cancel: false } });
    disconnect = channel.connect(grant.token);
    new RigRepository(db).setNodeInputRoute("a", "native");
  }
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), sleep: async () => {}, ...(channel ? { runnerChannel: channel } : {}) });
  repo.attachTransport(transport);
  return { db, repo, bus, row, pasted, submitted, transport, atLoad, state, channel, outbox, close: () => { disconnect?.(); db.close(); vi.restoreAllMocks(); } };
}

describe("wake claim admission remains true at its own payload", () => {
  it("positive: pending at buffer load, correlated claim at the own paste, one ordinary claim event", async () => {
    const f = await fixture();
    try {
      await f.repo.drainPendingWakeIntents();
      expect(f.atLoad).toEqual(["pending"]);
      expect(f.pasted).toEqual([{ text: expect.stringContaining(CLAIMED_BY_WAKE_LINE), state: "in-progress" }]);
      expect(f.db.prepare("SELECT count(*) n FROM events WHERE type='queue.claimed'").get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });

  it("never auto-claims an expired row or hands over a false claimed line for it", async () => {
    const f = await fixture("2000-01-01T00:00:00.000Z");
    try {
      await f.repo.drainPendingWakeIntents();
      expect.soft(f.state()).toBe("pending");
      expect.soft(f.pasted.some(p => p.text.includes(CLAIMED_BY_WAKE_LINE))).toBe(false);
    } finally { f.close(); }
  });

  it("does not paste the frozen work after a synchronous claim subscriber cancels it", async () => {
    const f = await fixture();
    const off = f.bus.subscribe(event => {
      if (event.type === "queue.claimed" && event.qitemId === f.row.qitemId) {
        expect(f.db.inTransaction).toBe(false); // the consumer sees a committed claim, not speculative state
        f.repo.update({ qitemId: f.row.qitemId, state: "done", closureReason: "canceled", actorSession: "worker@test", transitionNote: "withdrawn at claim" });
      }
    });
    try {
      await f.repo.drainPendingWakeIntents();
      expect(f.state()).toBe("done");
      expect(f.pasted).toEqual([]);
    } finally { off(); f.close(); }
  });

  it("the direct ladder-style override never tells a pending row it was claimed", async () => {
    const f = await fixture();
    try {
      // Exact default ladder retry renderer and public direct-nudge path, not an intent drain.
      const override = `${renderQueueHandoffNudge(f.row.qitemId, null)} Row source: sender@test.\n${renderQueueWakeBody(f.row.qitemId, wakeBody(f.row))}`;
      await f.repo.maybeNudge(f.row.qitemId, "worker@test", true, "daemon@kernel", override, "openrig");
      expect(f.pasted).toHaveLength(1);
      expect(f.pasted[0]!.state).toBe("pending");
      expect(f.pasted[0]!.text).not.toContain(CLAIMED_BY_WAKE_LINE);
    } finally { f.close(); }
  });

  it("keeps a native wake's claim when admission persisted but its return was lost", async () => {
    const f = await fixture(undefined, true);
    // RunnerChannel persists the offer before notifying listeners. A listener error loses the return, not the offer.
    const off = f.channel!.subscribe(() => { throw new Error("native admission return lost after persistence"); });
    try {
      await f.repo.drainPendingWakeIntents();
      const receipt = f.outbox.runnerReceipt(`wake-intent-${f.row.qitemId}`);
      expect(receipt).toMatchObject({ stage: "pending" });
      expect(f.state()).toBe("in-progress"); // worker can still take the persisted offer
      expect(f.db.prepare("SELECT claim_wake_outbox_id FROM queue_items WHERE qitem_id=?").get(f.row.qitemId))
        .toEqual({ claim_wake_outbox_id: `wake-intent-${f.row.qitemId}` });
    } finally { off(); f.close(); }
  });

  it.each([false, true].flatMap(native => (["occupant", "pane"] as const).map(change => ({ native, change }))))("rechecks $change authority after claim (native=$native)", async ({ native, change }) => {
    const f = await fixture(undefined, native);
    let changed = false;
    const off = f.bus.subscribe(event => {
      if (event.type !== "queue.claimed" || event.qitemId !== f.row.qitemId) return;
      if (change === "occupant") f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'g2','fresh')");
      if (change === "pane") f.db.exec("UPDATE bindings SET tmux_pane='%2' WHERE node_id='a'");
      changed = true;
    });
    try {
      await f.repo.drainPendingWakeIntents();
      expect(changed).toBe(true);
      expect(f.pasted).toEqual([]); // the row claim still matches, but its recipient authority does not
      if (native) expect(f.outbox.runnerReceipt(`wake-intent-${f.row.qitemId}`)).toBeNull();
      expect(f.state()).toBe("pending"); // positively no own input: return this untouched claim
    } finally { off(); f.close(); }
  });

  it("positive: a native offer claims its row just before the offer", async () => {
    const f = await fixture(undefined, true);
    try {
      await f.repo.drainPendingWakeIntents();
      expect(f.outbox.runnerReceipt(`wake-intent-${f.row.qitemId}`)).toMatchObject({ stage: "pending" });
      expect(f.state()).toBe("in-progress");
    } finally { f.close(); }
  });

  it.each(["claim fanout", "after paste"])("a stable binding refusal (%s) keeps known own-wake bytes from the next ordinary send", async changeAt => {
    const change = (db: Database.Database) => db.exec("UPDATE sessions SET resume_type='claude_id', resume_token='changed-conversation' WHERE id='s'");
    const f = await fixture(undefined, false, changeAt === "after paste" ? change : undefined);
    const off = f.bus.subscribe(event => {
      if (changeAt === "claim fanout" && event.type === "queue.claimed" && event.qitemId === f.row.qitemId) change(f.db);
    });
    try {
      await f.repo.drainPendingWakeIntents();
      if (f.pasted.length === 0 && changeAt === "claim fanout") {
        expect(f.state()).toBe("pending");
        expect(f.submitted).toEqual([]);
        return; // a positive refusal before the own paste is safe too
      }
      expect(f.pasted).toHaveLength(1); // stable guards don't fence conversation metadata at this paste
      expect(f.pasted[0]!.text).toContain("ORIGINAL-WORK");
      expect(f.submitted).toEqual([]); // stable's existing binding check withheld Enter
      expect(f.repo.getById(f.row.qitemId)!.lastNudgeWireResult).toContain("Recipient binding changed after paste");
      expect(f.state()).toBe("in-progress"); // paste was written, so its wake claim stays
      const next = await f.transport.send("worker@test", "FOLLOWUP");
      expect.soft(next).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect.soft(f.pasted).toHaveLength(1);
      expect.soft(f.submitted).toEqual([]); // C must keep this known refused wake out of a later submission
    } finally { off(); f.close(); }
  });
});
