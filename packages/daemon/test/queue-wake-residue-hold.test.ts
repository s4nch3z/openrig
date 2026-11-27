// A queue wake pasted and then refused before Enter (its row erased in between) leaves a durable hold: later automatic
// sends write nothing onto that pane process's input until it reads empty, including after a restart.
// Real transport/adapter/guard/domain, inert tmux executor; no terminal or daemon is launched.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// A real Claude Code idle screen: its input box reads empty with the cursor in it.
const IDLE = readFileSync(join(import.meta.dirname, "fixtures/input-box/claude-code-2.1.296/openrig-seat-accept-edits-idle.txt"), "utf8").replace(/\n$/, "");
const IDLE_ROW = IDLE.split("\n").findLastIndex((line) => line.startsWith("❯"));

async function heldSeat() {
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
  const seat = { pid: 10, screen: "", cursor: null as { x: number; y: number; width: number; height: number } | null, loaded: "", pasted: [] as string[], submitted: [] as string[] };
  let erased = false;
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
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
    vi.spyOn(tmux, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(tmux, "getPaneCursorPosition").mockImplementation(async () => seat.cursor);
    vi.spyOn(tmux, "getPanePid").mockImplementation(async () => seat.pid);
    return new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
      sleep: async ms => {
        if (ms !== 200 || erased) return;
        await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: row.qitemId, action: "scrub" }] }, apply: true, nowIso: new Date().toISOString() });
        erased = true;
      } });
  };
  const first = daemon();
  const wake = vi.spyOn(first, "send");
  repo.attachTransport(first);
  await repo.drainPendingWakeIntents();
  const holds = () => db.prepare("SELECT session_name, pane, pane_pid, occupant, outbox_id FROM seat_input_residue").all();
  return { db, row, seat, daemon, wakeResult: await wake.mock.results[0]!.value, holds };
}

describe("refused own-wake paste hold (stable C)", () => {
  it("records the input (pane and pane process) and the wake's receipt, never the text; the wake reports its text written, Enter not sent", async () => {
    const { db, row, seat, wakeResult, holds } = await heldSeat();
    try {
      expect(seat.pasted).toHaveLength(1);
      expect(seat.submitted).toEqual([]);
      expect(wakeResult).toMatchObject({ ok: false, sent: true, inputPhase: "written", reason: "draft_wake_superseded" });
      expect(holds()).toEqual([{ session_name: "worker@test", pane: "%1", pane_pid: 10, occupant: "occupant-1", outbox_id: `wake-intent-${row.qitemId}` }]);
      expect(JSON.stringify(db.prepare("SELECT * FROM seat_input_residue").all())).not.toContain("BODY-ERASED-BEFORE-ENTER");
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("after a restart, an automatic send writes nothing while the input isn't read empty (here no input box), and keeps the hold", async () => {
    const { db, seat, daemon, holds } = await heldSeat();
    try {
      const result = await daemon().send("worker@test", "FOLLOWUP");
      expect(result).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached", reason: "draft_input_unknown", heldInputBox: "no-input-box" });
      expect(result.error).toContain("Clear the seat's input");
      expect(seat.pasted).toHaveLength(1);
      expect(seat.submitted).toEqual([]);
      expect(holds()).toHaveLength(1);
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("a draft that reads typed is held as busy and left as it is", async () => {
    const { db, seat, daemon, holds } = await heldSeat();
    try {
      const lines = IDLE.split("\n");
      lines[IDLE_ROW] = "\x1b[0m❯ a person's draft";
      seat.screen = lines.join("\n");
      seat.cursor = { x: 18, y: IDLE_ROW, width: 120, height: 40 };
      const result = await daemon().send("worker@test", "FOLLOWUP");
      expect(result).toMatchObject({ ok: false, sent: false, reason: "draft_input_busy", heldInputBox: "typed" });
      expect(seat.pasted).toHaveLength(1);
      expect(seat.submitted).toEqual([]);
      expect(holds()).toHaveLength(1);
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("once the same input reads empty, the next send releases the hold and is delivered", async () => {
    const { db, seat, daemon, holds } = await heldSeat();
    try {
      seat.screen = `\x1b[0m${IDLE}`;
      seat.cursor = { x: 2, y: IDLE_ROW, width: 120, height: 40 };
      const result = await daemon().send("worker@test", "FOLLOWUP");
      expect(result).toMatchObject({ ok: true });
      expect(holds()).toEqual([]);
      expect(seat.pasted.at(-1)).toContain("FOLLOWUP");
      expect(seat.submitted).toHaveLength(1);
      expect(seat.submitted[0]).not.toContain("BODY-ERASED-BEFORE-ENTER");
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("a new occupant record alone stays held; a send to another pane process goes ahead and the hold stays for the old one", async () => {
    const { db, seat, daemon, holds } = await heldSeat();
    try {
      db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'occupant-2','fresh')");
      expect(await daemon().send("worker@test", "FOLLOWUP")).toMatchObject({ ok: false, sent: false, reason: "draft_input_unknown" });
      expect(holds()).toHaveLength(1);
      const residue = seat.screen;
      seat.pid = 11;
      seat.screen = "";
      const result = await daemon().send("worker@test", "FOLLOWUP");
      expect(result.reason ?? "").not.toMatch(/^draft_input_/);
      expect(seat.pasted.at(-1)).toContain("FOLLOWUP");
      expect(holds()).toHaveLength(1);
      // The binding returns to the first process, its text still in the input: held again, nothing submitted onto it.
      seat.pid = 10;
      seat.screen = residue;
      const back = await daemon().send("worker@test", "AGAIN");
      expect(back).toMatchObject({ ok: false, sent: false, inputPhase: "not_reached" });
      expect(seat.submitted.every(screen => !screen.includes("BODY-ERASED-BEFORE-ENTER"))).toBe(true);
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("an input read empty while its process can't be read takes the send but doesn't end the hold", async () => {
    const { db, seat, daemon, holds } = await heldSeat();
    try {
      seat.pid = null as unknown as number;
      seat.screen = `\x1b[0m${IDLE}`;
      seat.cursor = { x: 2, y: IDLE_ROW, width: 120, height: 40 };
      expect(await daemon().send("worker@test", "FOLLOWUP")).toMatchObject({ ok: true });
      expect(holds()).toHaveLength(1);
    } finally { db.close(); vi.restoreAllMocks(); }
  });

  it("a deliberate interaction is not held", async () => {
    const { db, daemon, holds } = await heldSeat();
    try {
      const result = await daemon().send("worker@test", "1", { dangerouslyInteract: true, reason: "answer a menu" } as never);
      expect(result.reason ?? "").not.toMatch(/^draft_input_/);
      expect(holds()).toHaveLength(1);
    } finally { db.close(); vi.restoreAllMocks(); }
  });
});
