// Independent real transport/adapter/guard/domain control with an inert executor: a tenure label doesn't erase a
// physical composer's known refused bytes. No terminal, provider or daemon is launched.
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

async function heldSeat(onErase?: (seat: { rootPid: number; screen: string }) => void) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','test');
    INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'occupant-1','fresh');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b','a','worker@test','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@test','running');`);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true,
    loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(new OutboxHandler(db));
  const row = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "BODY-ERASED-BEFORE-ENTER" });
  const seat = { rootPid: 10, screen: "", cursor: null as { x: number; y: number; width: number; height: number } | null, loaded: "", pasted: [] as string[], submitted: [] as string[] };
  let eraseId: string | null = row.qitemId;
  // Each transport is a daemon run: the hold must come from the database, not from the transport that recorded it.
  const daemon = () => {
    const tmux = new TmuxAdapter(async command => {
      const line = String(command);
      const buffer = /load-buffer .* '([^']+)'$/.exec(line);
      if (buffer) seat.loaded = readFileSync(buffer[1]!, "utf8");
      if (line.includes("paste-buffer")) { seat.pasted.push(seat.loaded); seat.screen += seat.loaded; }
      if (line.includes("send-keys") && line.includes("Enter")) seat.submitted.push(seat.screen);
      return line.includes("capture-pane") ? seat.screen : "";
    });
    tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
    vi.spyOn(tmux, "getPanePid").mockImplementation(async () => seat.rootPid);
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(tmux, "getPaneCursorPosition").mockImplementation(async () => seat.cursor);
    return new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
      sleep: async ms => {
        if (ms !== 200 || !eraseId) return;
        await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: eraseId, action: "scrub" }] }, apply: true, nowIso: new Date().toISOString() });
        eraseId = null;
        onErase?.(seat);
      } });
  };
  const first = daemon();
  const wake = vi.spyOn(first, "send");
  repo.attachTransport(first);
  await repo.drainPendingWakeIntents();
  const holds = () => db.prepare("SELECT session_name, pane, occupant, outbox_id FROM seat_input_residue").all();
  return { db, row, seat, daemon, eraseNext: (id: string) => { eraseId = id; }, wakeResult: await wake.mock.results[0]!.value, holds };
}

describe("known refused own-wake residue belongs to its physical input", () => {
  it("a generation metadata change doesn't clear the old physical input or release its hold", async () => {
    const f = await heldSeat();
    try {
      const before = f.seat.screen;
      expect(f.wakeResult).toMatchObject({ sent: true, inputPhase: "written", reason: "draft_wake_superseded" });
      expect(f.holds()).toHaveLength(1);
      expect(before).toContain("BODY-ERASED-BEFORE-ENTER");
      expect(f.seat.submitted).toEqual([]);
      f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'occupant-2','fresh')");
      // No receiver/process/input changed. A reconstructed transport must still find the durable hold.
      const result = await f.daemon().send("worker@test", "FOLLOWUP");
      expect.soft(f.seat.rootPid).toBe(10);
      expect.soft(f.seat.screen).toBe(before);
      expect.soft(f.seat.pasted).toHaveLength(1);
      expect.soft(f.seat.submitted).toEqual([]);
      expect.soft(f.holds()).toHaveLength(1);
      expect.soft(result).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
    } finally { f.db.close(); vi.restoreAllMocks(); }
  });

  it("positive: a replacement pane process has its own input and never inherits the erased body's bytes", async () => {
    const f = await heldSeat();
    try {
      const previousInput = f.seat.screen;
      f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'occupant-2','fresh')");
      f.seat.rootPid = 11; // adapter's observed physical receiver changes, rather than only its tenure metadata
      f.seat.screen = "successor process output with no recognized input box\n";
      const result = await f.daemon().send("worker@test", "FOLLOWUP");
      expect(previousInput).toContain("BODY-ERASED-BEFORE-ENTER");
      expect(f.holds()).toHaveLength(1);
      expect(result.ok).toBe(true);
      expect(f.seat.submitted).toHaveLength(1);
      expect(f.seat.submitted[0]).toContain("FOLLOWUP");
      expect(f.seat.submitted[0]).not.toContain("BODY-ERASED-BEFORE-ENTER");
      f.seat.rootPid = 10;
      f.seat.screen = previousInput;
      const back = await f.daemon().send("worker@test", "BACK-TO-ORIGINAL");
      expect(back).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect(f.seat.screen).toBe(previousInput);
      expect(f.seat.submitted).toHaveLength(1);
    } finally { f.db.close(); vi.restoreAllMocks(); }
  });

  it("a failed unproven pane-label change can't discard the hold before returning to the old physical input", async () => {
    const f = await heldSeat();
    try {
      const before = f.seat.screen;
      f.db.exec("UPDATE bindings SET tmux_pane='%2' WHERE node_id='a'");
      // The real adapter's listPanes still proves only %1. No paste can reach the unproven %2 target.
      const refused = await f.daemon().send("worker@test", "UNPROVEN-TARGET");
      expect(refused.ok).toBe(false);
      expect(f.seat.screen).toBe(before);
      expect(f.seat.pasted).toHaveLength(1);
      expect.soft(f.holds()).toHaveLength(1);
      f.db.exec("UPDATE bindings SET tmux_pane='%1' WHERE node_id='a'");
      const back = await f.daemon().send("worker@test", "BACK-AT-ORIGINAL");
      expect.soft(back).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect.soft(f.seat.screen).toBe(before);
      expect.soft(f.seat.submitted).toEqual([]);
      expect.soft(f.holds()).toHaveLength(1);
    } finally { f.db.close(); vi.restoreAllMocks(); }
  });

  it("a second refused wake in another process doesn't overwrite the original process's hold", async () => {
    const f = await heldSeat();
    try {
      const firstInput = f.seat.screen;
      f.seat.rootPid = 11;
      f.seat.screen = "";
      const secondRepo = new QueueRepository(f.db, new EventBus(f.db), { validateRig: () => true,
        loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
      secondRepo.attachOutbox(new OutboxHandler(f.db));
      const second = await secondRepo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "SECOND-ERASED-BODY" });
      f.eraseNext(second.qitemId);
      const transport = f.daemon();
      const sends = vi.spyOn(transport, "send");
      secondRepo.attachTransport(transport);
      await secondRepo.drainPendingWakeIntents();
      const receipts = await Promise.all(sends.mock.results.map(r => r.value));
      expect(receipts).toContainEqual(expect.objectContaining({ sent: true, inputPhase: "written", reason: "draft_wake_superseded" }));
      expect(f.seat.screen).toContain("SECOND-ERASED-BODY");
      expect(f.seat.submitted).toEqual([]);
      f.seat.rootPid = 10;
      f.seat.screen = firstInput;
      const back = await f.daemon().send("worker@test", "FOLLOWUP-ORIGINAL");
      expect.soft(back).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect.soft(f.seat.screen).toBe(firstInput);
      expect.soft(f.seat.submitted).toEqual([]);
    } finally { f.db.close(); vi.restoreAllMocks(); }
  });

  it("records the process that received the paste, not a different receiver observed after the refusal", async () => {
    let originalInput = "";
    const f = await heldSeat(seat => {
      originalInput = seat.screen;
      seat.rootPid = 11;
      seat.screen = "different process output\n";
    });
    try {
      expect(originalInput).toContain("BODY-ERASED-BEFORE-ENTER");
      expect(f.wakeResult).toMatchObject({ sent: true, inputPhase: "written", reason: "draft_wake_superseded" });
      expect(f.seat.submitted).toEqual([]);
      f.seat.rootPid = 10;
      f.seat.screen = originalInput;
      const back = await f.daemon().send("worker@test", "FOLLOWUP-PASTED-RECEIVER");
      expect.soft(back).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect.soft(f.seat.screen).toBe(originalInput);
      expect.soft(f.seat.submitted).toEqual([]);
    } finally { f.db.close(); vi.restoreAllMocks(); }
  });
});

