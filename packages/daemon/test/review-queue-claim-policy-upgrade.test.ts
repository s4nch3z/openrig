import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

it("upgrading existing pending and manually claimed work does not opt it in or invent wake claims", async () => {
  const db = createDb();
  try {
    const boundary = ALL_MIGRATIONS.findIndex(m => m.name === "196_queue_claim_on_wake.sql");
    expect(boundary).toBeGreaterThan(0);
    migrate(db, ALL_MIGRATIONS.slice(0, boundary));
    const bus = new EventBus(db), old = new QueueRepository(db, bus, { validateRig: () => true });
    const pending = await old.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "pending work", nudge: false });
    const held = await old.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "claimed work", nudge: false });
    await old.claim({ qitemId: held.qitemId, destinationSession: "dev@rig" });
    const rows = () => db.prepare("SELECT qitem_id,state,body,source_session,destination_session,claimed_at FROM queue_items ORDER BY qitem_id").all();
    const before = rows(), transitions = db.prepare("SELECT * FROM queue_transitions ORDER BY transition_id").all();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    expect(rows()).toEqual(before);
    expect(db.prepare("SELECT * FROM queue_transitions ORDER BY transition_id").all()).toEqual(transitions);
    for (const id of [pending.qitemId, held.qitemId]) {
      expect(repo.getById(id)).not.toHaveProperty("claimOnWake");
      expect(db.prepare("SELECT claim_on_wake,claim_wake_outbox_id,claim_wake_transition_id FROM queue_items WHERE qitem_id=?").get(id))
        .toEqual({ claim_on_wake: 0, claim_wake_outbox_id: null, claim_wake_transition_id: null });
    }
    expect((await repo.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "new opt-in", nudge: false, claimOnWake: true })).claimOnWake).toBe(true);
  } finally { db.close(); }
});
