import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";

it("an opted-in local row exports as supported v2 and stages without enabling destination work or moving local claim authority", async () => {
  const source = new Database(":memory:"), destination = new Database(":memory:");
  try {
    for (const db of [source, destination]) migrate(db, ALL_MIGRATIONS);
    source.exec("INSERT INTO self_host_identity VALUES (1,'origin','minted','reconciled')");
    const repo = new QueueRepository(source, new EventBus(source), { validateRig: () => true });
    const row = await repo.create({ sourceSession: "lead@rig", destinationSession: "worker@rig", body: "LOCAL-OPTED-WORK", claimOnWake: true, nudge: false });
    const transfer = buildQueueTransfer(source, { kind: "qitems", names: [row.qitemId] });
    const envelope = JSON.parse(transfer.archive);
    expect(envelope.format).toBe("openrig.queue-transfer/v2");
    expect(envelope.rows).toHaveLength(1);
    expect(envelope.rows[0]).toMatchObject({ qitemId: row.qitemId, body: "LOCAL-OPTED-WORK", state: "pending" });
    expect(Object.keys(envelope.rows[0]).filter(key => /claim.*wake/i.test(key))).toEqual([]);
    const staged = new QueueTransferStaging(destination).import(transfer.archive);
    expect(staged).toMatchObject({ status: "not_ready_for_activation", stage: { status: "staged", rowCount: 1 } });
    expect(destination.prepare("SELECT COUNT(*) c FROM queue_items").get()).toEqual({ c: 0 });
    expect(destination.prepare("SELECT COUNT(*) c FROM outbox_entries").get()).toEqual({ c: 0 });
    expect(repo.getById(row.qitemId)).toMatchObject({ claimOnWake: true, body: "LOCAL-OPTED-WORK", state: "pending" });
  } finally { source.close(); destination.close(); }
});
