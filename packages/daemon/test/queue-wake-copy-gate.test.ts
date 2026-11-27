// A queue wake's outbox copy carries its row's text: a seat reader sees it only while the row is on this host.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { wakeCopyBodyGate } from "../src/routes/queue.js";

describe("wakeCopyBodyGate", () => {
  it("holds a gone row's wake copy text from a seat; other readers, live rows and other entries are unchanged", async () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    db.exec("INSERT INTO rigs(id,name) VALUES ('r','test'); INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','r','worker','claude-code');");
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
    const live = await repo.create({ sourceSession: "sender@test", destinationSession: "worker@test", body: "LIVE-BODY", nudge: false });
    const entries = [
      { outboxId: `wake-intent-${live.qitemId}`, auditPointer: live.qitemId, body: "LIVE-BODY" },
      { outboxId: "wake-intent-qitem-gone", auditPointer: "qitem-gone", body: "GONE-BODY" },
      { outboxId: "guard-nudge-1", auditPointer: "qitem-gone", body: "GONE-NUDGE" },
      { outboxId: "message-1", auditPointer: "qitem-gone", body: "ORDINARY" },
    ];
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); await next(); });
    app.get("/copies", c => c.json(entries.map(wakeCopyBodyGate(c))));
    try {
      const seat = await (await app.request("/copies", { headers: { "x-openrig-session": "worker@test" } })).json() as Array<Record<string, unknown>>;
      expect(seat.map(e => e.body)).toEqual(["LIVE-BODY", undefined, undefined, "ORDINARY"]);
      expect(seat[1]).toMatchObject({ outboxId: "wake-intent-qitem-gone", bodyHeld: { code: "qitem_unavailable" } });
      expect(JSON.stringify(seat)).not.toMatch(/GONE-BODY|GONE-NUDGE/);
      const other = await (await app.request("/copies")).json() as Array<Record<string, unknown>>;
      expect(other.map(e => e.body)).toEqual(["LIVE-BODY", "GONE-BODY", "GONE-NUDGE", "ORDINARY"]);
    } finally { db.close(); }
  });
});
