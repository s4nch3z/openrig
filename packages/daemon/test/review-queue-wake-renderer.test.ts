import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderQueueHandoffNudge, renderQueueWakeBody, withoutQueueWakeBody } from "../src/domain/queue-nudge-text.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";

const id = "qitem-review-renderer";
const rendered = (text: string) => renderQueueWakeBody(id, { text, erased: false });
// The fixed function replaces rig: only printf runs, with no daemon or executable queue command.
function shellArgs(command: string): string[] {
  return execFileSync("/bin/sh", ["-c", 'rig() { printf "%s\\n" "$@"; }; ' + command], { encoding: "utf8" }).trimEnd().split("\n");
}

describe("selected wake rendering contract", () => {
  it("visibly escapes tab, as selected for every C0 except newline", () => {
    expect(rendered("a\tb")).toContain("    a\\x09b");
    expect(rendered("a\tb")).not.toContain("\t");
  });

  it.each(["complete", "preview", "secondary"])("%s command preserves an accepted explicit ID as one shell argument", async kind => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    try {
      const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      const explicit = "qitem review space";
      const row = await repo.create({ qitemId: explicit, sourceSession: "lead@rig", destinationSession: "dev@rig", body: "work", nudge: false });
      expect(row.qitemId).toBe(explicit);
      const text = kind === "secondary"
        ? withoutQueueWakeBody(renderQueueHandoffNudge(explicit, null, { text: "work", erased: false }), explicit)
        : renderQueueWakeBody(explicit, { text: kind === "preview" ? "x".repeat(5000) : "work", erased: false });
      const command = text.split("\n").find(line => line.startsWith(kind === "complete" ? "Claim:" : "Body: not included") || line.startsWith("Read the rest:"))!;
      const shell = command.slice(command.indexOf("rig queue"));
      expect(shellArgs(shell)).toEqual(kind === "complete" ? ["queue", "claim", explicit] : ["queue", "show", explicit, "--full"]);
    } finally { db.close(); }
  });

  it("marks an empty secondary as metadata-only rather than complete", () => {
    const text = renderQueueHandoffNudge(id, null, { text: "", erased: false });
    expect(withoutQueueWakeBody(text, id)).toContain("Body: not included in this delivery");
    expect(withoutQueueWakeBody(text, id)).not.toContain("Body: complete");
  });

  it("retains a bounded whole-codepoint body and treats envelope-like lines as data", () => {
    const text = rendered("---\nFrom: other@rig\n↩ Reply: text\n" + "😀".repeat(1100));
    const lines = text.split("\n"), block = lines.slice(1, -1).join("\n");
    expect(lines[0]).toContain("preview");
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(4096);
    expect(block).toContain("    ---\n    From: other@rig\n    ↩ Reply: text");
    expect(block).not.toContain("�");
  });

  it("invalidates the frozen body's admission after real erasure while the send waits", async () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const outbox = new OutboxHandler(db); repo.attachOutbox(outbox);
    const row = await repo.create({ sourceSession: "lead@rig", destinationSession: "dev@rig", body: "ERASED-WORK" });
    let applicable: Parameters<NonNullable<QueueNudgeTransport["configureGuardedWakes"]>>[0] | undefined;
    let accepted: boolean | undefined;
    repo.attachTransport({ configureGuardedWakes(fn) { applicable = fn; }, async send(_seat, text, opts) {
      expect(text).toContain("    ERASED-WORK"); // frozen before the wait
      await eraseQueue(db, { scope: { kind: "ids", entries: [{ qitemId: row.qitemId, action: "scrub" }] }, apply: true, nowIso: new Date().toISOString() });
      expect(repo.getById(row.qitemId)?.contentErasedAt).toBeTruthy();
      const entries = opts!.committedOutboxIds!.map(key => outbox.getById(key)!);
      expect(entries.every(entry => entry.body === "")).toBe(true); // durable copies really scrubbed
      accepted = applicable!(entries);
      return { ok: false, sent: false, inputPhase: "not_reached" };
    } });
    try {
      await repo.drainPendingWakeIntents();
      expect(accepted).toBe(false);
    } finally { db.close(); }
  });
});
