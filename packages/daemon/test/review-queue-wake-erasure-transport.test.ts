// Real transport/adapter/guard/domain, inert tmux executor; no terminal or daemon is launched.
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
import { eraseQueue } from "../src/domain/queue-erasure.js";

describe("default typed wake snapshot after erasure", () => {
  it.each(["none", "scrub-buffer", "delete-lease", "scrub-submit"] as const)("erasure stage=%s preserves snapshot and leftover applicability", async stage => {
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
    const row = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "BODY-ERASE-BOUNDARY" });
    let loaded = "", pane = "", erased = false;
    const pasted: string[] = [], submitted: string[] = [];
    const erase = async (action: "scrub" | "delete") => {
      await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: row.qitemId, action }] }, apply: true, nowIso: new Date().toISOString() });
      erased = true;
    };
    const tmux = new TmuxAdapter(async command => {
      const line = String(command);
      const buffer = /load-buffer .* '([^']+)'$/.exec(line);
      if (buffer) {
        loaded = readFileSync(buffer[1]!, "utf8");
        if (stage === "scrub-buffer" && !erased) await erase("scrub");
      }
      if (line.includes("paste-buffer")) { pasted.push(loaded); pane += loaded; }
      if (line.includes("send-keys") && line.includes("Enter")) submitted.push(pane);
      return line.includes("capture-pane") ? pane : "";
    });
    tmux.deliveryGuard = guard;
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
      sleep: async ms => { if (ms === 200 && stage === "scrub-submit" && !erased) await erase("scrub"); } });
    const sent = vi.spyOn(transport, "send");
    repo.attachTransport(transport);
    if (stage === "delete-lease") {
      const operation = guard.operation.bind(guard);
      vi.spyOn(guard, "operation").mockImplementation(async (name, fn, retained, admission) => {
        if (!erased) await erase("delete");
        return operation(name, fn, retained, admission);
      });
    }
    try {
      expect(guard.needsInputCheck("worker@test")).toBe(false); // ordinary default route, not draft-aware
      // Deleting a sending outbox can also make later receipt finalization throw. Inspect the input effect even then;
      // a bookkeeping error after the write is not evidence that the deleted body stayed untyped.
      try { await repo.drainPendingWakeIntents(); }
      catch (error) { if (stage !== "delete-lease") throw error; }
      if (stage === "delete-lease") {
        expect(erased).toBe(true);
        expect(repo.getById(row.qitemId)).toBeNull();
        expect(outbox.getById(`wake-intent-${row.qitemId}`)).toBeNull();
        expect(pasted).toEqual([]);
      } else if (stage === "scrub-submit") {
        expect(erased).toBe(true);
        expect(pasted).toHaveLength(1); // cannot undo the fact of an earlier paste
        expect(submitted).toEqual([]);
        expect(await sent.mock.results[0]!.value).toMatchObject({ sent: true, inputPhase: "written" });
        await transport.send("worker@test", "FOLLOWUP");
        expect.soft(pasted).toHaveLength(1); // retained bytes are not permission for the next send to submit them
        expect.soft(submitted).toEqual([]);
      } else if (stage === "scrub-buffer") {
        expect(erased).toBe(true);
        expect(repo.getById(row.qitemId)?.contentErasedAt).toBeTruthy();
        expect(outbox.getById(`wake-intent-${row.qitemId}`)?.body).toBe("");
        expect(pasted).toEqual([]);
      } else {
        expect(pasted).toHaveLength(1);
        expect(pasted[0]).toContain("    BODY-ERASE-BOUNDARY");
      }
    } finally { db.close(); vi.restoreAllMocks(); }
  });
});
