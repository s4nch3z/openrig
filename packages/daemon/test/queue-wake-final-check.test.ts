// A queue wake's last check before its write runs on every route: the ordinary typed route (not draft-aware) and the
// native offer refuse a wake whose row no longer wants it, checked after every await of the send. Real migrated SQLite,
// queue, outbox, transport, tmux adapter and delivery guard; the tmux executor only records commands.
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
import { eraseQueue } from "../src/domain/queue-erasure.js";

async function fixture(opts: { native?: boolean } = {}) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'occupant-1','fresh');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@test','running');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const outbox = new OutboxHandler(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
    loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(outbox);
  const row = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "FINAL-CHECK-BODY" });
  let loaded = "", pane = "";
  const pasted: string[] = [];
  let onLoad: () => Promise<void> = async () => {};
  const tmux = new TmuxAdapter(async command => {
    const line = String(command);
    const buffer = /load-buffer .* '([^']+)'$/.exec(line);
    if (buffer) { loaded = readFileSync(buffer[1]!, "utf8"); await onLoad(); }
    if (line.includes("paste-buffer")) { pasted.push(loaded); pane += loaded; }
    return line.includes("capture-pane") ? pane : "";
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
  const erase = () => eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: row.qitemId, action: "scrub" }] }, apply: true, nowIso: new Date().toISOString() });
  const done = () => { for (const c of cleanup) c(); db.close(); vi.restoreAllMocks(); };
  return { db, repo, outbox, guard, row, pasted, channel, erase, done, setOnLoad: (fn: () => Promise<void>) => { onLoad = fn; } };
}

describe("queue wake final check on every route", () => {
  it("the ordinary typed route doesn't paste a wake whose row was claimed while the send prepared it", async () => {
    const f = await fixture();
    try {
      expect(f.guard.needsInputCheck("worker@test")).toBe(false);
      f.setOnLoad(async () => { await f.repo.claim({ qitemId: f.row.qitemId, destinationSession: "worker@test" }); });
      await f.repo.drainPendingWakeIntents();
      expect(f.repo.getById(f.row.qitemId)?.state).toBe("in-progress");
      expect(f.pasted).toEqual([]);
      expect(f.repo.getById(f.row.qitemId)?.lastNudgeResult).toMatch(/no longer applicable/);
    } finally { f.done(); }
  });

  it.each([false, true])("the native route offers nothing for a body erased after the wake was rendered (erased=%s)", async erased => {
    const f = await fixture({ native: true });
    try {
      const admit = vi.spyOn(f.channel!, "admit");
      if (erased) {
        // After the drain has the frozen text in hand, just before the offer: the lease is the send's last await.
        const operation = f.guard.operation.bind(f.guard);
        vi.spyOn(f.guard, "operation").mockImplementation(async (name, fn, retained, admission) => {
          await f.erase();
          return operation(name, fn, retained, admission);
        });
      }
      await f.repo.drainPendingWakeIntents();
      expect(f.pasted).toEqual([]);
      if (erased) {
        expect(f.repo.getById(f.row.qitemId)?.contentErasedAt).toBeTruthy();
        expect(admit).not.toHaveBeenCalled();
      } else {
        expect(admit).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(admit.mock.calls[0]![1])).toContain("FINAL-CHECK-BODY");
      }
    } finally { f.done(); }
  });
});
