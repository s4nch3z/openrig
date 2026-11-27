// Independent real HTTP/domain bridge controls; no terminal or provider is started.
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { HookBridge } from "../src/domain/hook-bridge.js";
import { hookBridgeRoutes } from "../src/routes/hook-bridge.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { CLAIMED_BY_WAKE_LINE } from "../src/domain/queue-nudge-text.js";

async function fixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'g1','fresh');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@test','running');`);
  const bus = new EventBus(db), outbox = new OutboxHandler(db), registry = new SessionRegistry(db);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const bridge = new HookBridge(db, { lease: (id, fn) => guard.exclusive(id, fn) });
  const tmux = new TmuxAdapter(async () => ""); tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: registry, hookBridge: bridge, sleep: async () => {} });
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox); repo.attachTransport(transport);
  bridge.setPreference("a", true, "human@test", "fixture");
  const { armId } = bridge.arm({ nodeId: "a", sessionName: "worker@test", generation: "g1", hookEvent: "SessionStart" });
  const store = new AgentActivityStore({ db, eventBus: bus });
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ agentActivityStore: store, activityHookToken: "fixture-token", sessionRegistry: registry, tmuxAdapter: tmux, hookBridge: bridge })) c.set(key as never, value as never);
    await next();
  });
  app.route("/api/hook-bridge", hookBridgeRoutes);
  const post = async (path: string, extra = {}) => {
    const res = await app.request(`/api/hook-bridge/${path}`, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "a", sessionName: "worker@test", generation: "g1", armId, ...extra }) });
    return { status: res.status, body: await res.json() as { action?: string; batchId?: string; messages?: Array<{ outboxId: string; text: string }>; outboxIds?: string[] } };
  };
  const wake = async (body = "ORIGINAL-WORK", claimOnWake = true) => {
    const row = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body, claimOnWake });
    await vi.waitFor(() => expect(repo.getById(row.qitemId)?.lastNudgeResult).toBe("bridged:queued"));
    return row;
  };
  return { db, bus, repo, bridge, outbox, wake, post, close: () => { db.close(); vi.restoreAllMocks(); } };
}

describe("hook bridge wake claim remains bound to the actual handover", () => {
  it("positive: committed claim before HTTP body, one primary, stable replay and no second claim", async () => {
    const f = await fixture();
    try {
      const first = await f.wake("FIRST-BODY"), second = await f.wake("SECOND-BODY");
      const seen: boolean[] = [];
      f.bus.subscribe(e => { if (e.type === "queue.claimed") seen.push(f.db.inTransaction); });
      const one = await f.post("poll");
      expect(one.status).toBe(200); expect(one.body.action).toBe("deliver");
      expect(seen).toEqual([false]);
      expect(one.body.messages).toHaveLength(2);
      expect(one.body.messages![0]!.text).toContain("FIRST-BODY");
      expect(one.body.messages![0]!.text).toContain(CLAIMED_BY_WAKE_LINE);
      expect(one.body.messages![1]!.text).not.toContain("SECOND-BODY");
      expect(f.repo.getById(first.qitemId)?.state).toBe("in-progress");
      expect(f.repo.getById(second.qitemId)?.state).toBe("pending");
      expect(await f.post("poll")).toEqual(one);
      expect(seen).toEqual([false]);
    } finally { f.close(); }
  });

  it("does not hand over a frozen body whose scrub is committed by the claim notification", async () => {
    const f = await fixture();
    try {
      const row = await f.wake();
      f.bus.subscribe(e => { if (e.type === "queue.claimed" && e.qitemId === row.qitemId) {
        // The committed body/copy state left by eraseQueue. Its public async operation yields before committing;
        // merely starting that operation in this synchronous callback is not proof this state exists at the fence.
        f.db.transaction(() => {
          f.db.prepare("UPDATE queue_items SET body='', content_erased_at=? WHERE qitem_id=?").run(new Date().toISOString(), row.qitemId);
          f.db.prepare("UPDATE outbox_entries SET body='' WHERE audit_pointer=?").run(row.qitemId);
        })();
        expect(f.repo.getById(row.qitemId)?.contentErasedAt).toBeTruthy();
      }
      });
      const answer = await f.post("poll");
      expect(f.repo.getById(row.qitemId)?.contentErasedAt).toBeTruthy();
      expect(JSON.stringify(answer.body)).not.toContain("ORIGINAL-WORK");
      expect(f.repo.getById(row.qitemId)?.state).toBe("pending");
    } finally { f.close(); }
  });

  it("distinguishes an async erase request from a scrub already committed at the synchronous poll fence", async () => {
    const f = await fixture();
    try {
      const row = await f.wake();
      let erasure: ReturnType<typeof eraseQueue> | undefined;
      let atFence: string | null | undefined;
      f.bus.subscribe(e => { if (e.type === "queue.claimed" && e.qitemId === row.qitemId) {
        erasure = eraseQueue(f.db, { scope: { kind: "ids", entries: [{ qitemId: row.qitemId, action: "scrub" }] }, apply: true, nowIso: new Date().toISOString() });
        atFence = f.repo.getById(row.qitemId)?.contentErasedAt;
      } });
      const answer = await f.post("poll"); await erasure;
      expect(atFence ?? null).toBeNull();
      expect(f.repo.getById(row.qitemId)?.contentErasedAt).toBeTruthy();
      expect(answer.body.messages![0]!.text).toContain("ORIGINAL-WORK"); // authorized before that async commit
    } finally { f.close(); }
  });

  it.each([false, true])("an old claimed batch cannot reuse a subsequently unclaimed row (manual reclaim=%s)", async reclaim => {
    const f = await fixture();
    try {
      const row = await f.wake();
      const first = await f.post("poll"); expect(first.body.action).toBe("deliver");
      f.repo.unclaim(row.qitemId, "worker@test", "old batch no longer owns this work");
      if (reclaim) f.repo.claim({ qitemId: row.qitemId, destinationSession: "worker@test" });
      expect(f.repo.getById(row.qitemId)?.claimWakeOutboxId ?? null).toBeNull();
      const replay = await f.post("poll");
      expect(JSON.stringify(replay.body)).not.toContain("ORIGINAL-WORK");
    } finally { f.close(); }
  });

  it("returns its untouched pre-input claim when notification replaces the HTTP waiter's occupant", async () => {
    const f = await fixture();
    try {
      const row = await f.wake();
      f.bus.subscribe(e => { if (e.type === "queue.claimed" && e.qitemId === row.qitemId)
        f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'g2','fresh')");
      });
      const answer = await f.post("poll");
      expect(answer.status).toBe(409);
      expect(JSON.stringify(answer.body)).not.toContain("ORIGINAL-WORK");
      expect(f.repo.getById(row.qitemId)?.state).toBe("pending");
    } finally { f.close(); }
  });

  it("positive: an old batch ack never acknowledges or changes the next batch's claim", async () => {
    const f = await fixture();
    try {
      await f.wake("OLD-BODY");
      const first = await f.post("poll");
      expect((await f.post("ack", { batchId: first.body.batchId })).body.outboxIds).toHaveLength(1);
      const arm = await f.post("arm", { armId: "next-arm", hookEvent: "Stop" });
      expect(arm.status).toBe(200);
      const row = await f.wake("NEW-BODY");
      const next = await f.post("poll", { armId: "next-arm" });
      expect(next.body.messages![0]!.text).toContain("NEW-BODY");
      const before = f.repo.getById(row.qitemId);
      expect((await f.post("ack", { batchId: first.body.batchId })).body.outboxIds).toEqual([]);
      expect(f.repo.getById(row.qitemId)).toEqual(before);
      expect(f.outbox.getById(`wake-intent-${row.qitemId}`)?.deliveryState).toBe("sending");
    } finally { f.close(); }
  });
});
