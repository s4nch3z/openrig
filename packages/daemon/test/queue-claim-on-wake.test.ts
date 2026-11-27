// Claim on wake, as stored: a row's opt-in (default off) is kept on create and on a handoff's new row only when asked;
// it's refused for a person's address and for another host before anything is written or forwarded; and a same-ID retry
// that changes it is a 409 naming the stored policy, never a changed row or a second wake.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "CLAIM_ON_WAKE_B" }] };
process.env["CLAIM_ON_WAKE_B"] = "remote-token";

function harness() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, warnings: [], entities: [{
    entityId: "founder", class: "human", displayName: "Founder", address: "founder@external", connectorBindings: [], prefs: { deliveryClass: "A" },
  }] }) } as never);
  repo.attachOutbox(new OutboxHandler(db));
  let forwarded = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", repo);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", (async () => { forwarded++; return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }); }) as unknown as typeof fetch);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const post = (path: string, body: Record<string, unknown>) => app.request(path, { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": String(body.fromSession ?? body.sourceSession) }, body: JSON.stringify(body) });
  const stored = (id: string) => (db.prepare("SELECT claim_on_wake FROM queue_items WHERE qitem_id = ?").get(id) as { claim_on_wake: number } | undefined)?.claim_on_wake;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  return { db, repo, post, stored, count, forwarded: () => forwarded };
}

const CREATE = { sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "the work", summary: "s" };

describe("claim on wake, stored", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => (h?.db as Database.Database | undefined)?.close());

  it("create keeps the opt-in; a row without it reads and stores as before", async () => {
    h = harness();
    const opted = await h.repo.create({ ...CREATE, claimOnWake: true, nudge: false });
    const plain = await h.repo.create({ ...CREATE, nudge: false });
    expect(h.repo.getById(opted.qitemId)?.claimOnWake).toBe(true);
    expect(h.stored(opted.qitemId)).toBe(1);
    expect(h.repo.getById(plain.qitemId)).not.toHaveProperty("claimOnWake");
    expect(h.stored(plain.qitemId)).toBe(0);
  });

  it.each(["handoff", "handoff-and-complete"])("%s: the new row has it only when the handoff asks, never from the source", async (verb) => {
    h = harness();
    const a = await h.repo.create({ ...CREATE, claimOnWake: true, nudge: false });
    const b = await h.repo.create({ ...CREATE, nudge: false });
    const inherited = await (await h.post(`/api/queue/${a.qitemId}/${verb}`, { fromSession: "worker@rig-a", toSession: "qa@rig-a", nudge: false })).json();
    const asked = await (await h.post(`/api/queue/${b.qitemId}/${verb}`, { fromSession: "worker@rig-a", toSession: "qa@rig-a", nudge: false, claimOnWake: true })).json();
    expect(inherited.created).not.toHaveProperty("claimOnWake");
    expect(h.stored(inherited.created.qitemId)).toBe(0);
    expect(asked.created.claimOnWake).toBe(true);
    expect(h.stored(asked.created.qitemId)).toBe(1);
  });

  it("is refused for a person's address, and for a value that isn't a boolean, before anything is written", async () => {
    h = harness();
    const person = await h.post("/api/queue/create", { ...CREATE, destinationSession: "human@host", evidenceRef: "PROOF.md", claimOnWake: true, nudge: false });
    expect(person.status).toBe(400);
    expect((await person.json()).error).toBe("claim_on_wake_unsupported_destination");
    // A registered person addressed as their seat is a person too.
    const registered = await h.post("/api/queue/create", { ...CREATE, destinationSession: "founder@rig-a", evidenceRef: "PROOF.md", claimOnWake: true, nudge: false });
    expect(registered.status).toBe(400);
    expect((await registered.json()).error).toBe("claim_on_wake_unsupported_destination");
    const invalid = await h.post("/api/queue/create", { ...CREATE, claimOnWake: "yes", nudge: false });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_claim_on_wake");
    expect(h.count("queue_items")).toBe(0);
  });

  it.each([[false, true], [true, false]])("a same-ID retry that changes it (stored %s, asked %s) is a 409 with the stored policy; nothing changes or stages again", async (first, retry) => {
    h = harness();
    const id = "qitem-20261126000000-00000000000000aa";
    expect((await h.post("/api/queue/create", { ...CREATE, qitemId: id, ...(first ? { claimOnWake: true } : {}) })).status).toBe(201);
    const outboxBefore = h.count("outbox_entries"), transitionsBefore = h.count("queue_transitions");
    const res = await h.post("/api/queue/create", { ...CREATE, qitemId: id, ...(retry ? { claimOnWake: true } : {}) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "qitem_claim_on_wake_conflict", qitemId: id, storedClaimOnWake: first, requestedClaimOnWake: retry });
    expect(h.stored(id)).toBe(first ? 1 : 0);
    expect(h.count("outbox_entries")).toBe(outboxBefore);
    expect(h.count("queue_transitions")).toBe(transitionsBefore);
    // The same policy again is an ordinary same-ID retry.
    expect((await h.post("/api/queue/create", { ...CREATE, qitemId: id, ...(first ? { claimOnWake: true } : {}) })).status).toBeLessThan(300);
  });

  it("another host's create with it is refused before forwarding; without it, it forwards as before", async () => {
    h = harness();
    const refused = await h.post("/api/queue/create", { ...CREATE, destinationSession: "dev@rig-b", hostId: "vps-b", claimOnWake: true });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("claim_on_wake_cross_host_unsupported");
    expect(h.forwarded()).toBe(0);
    await h.post("/api/queue/create", { ...CREATE, destinationSession: "dev@rig-b", hostId: "vps-b" });
    expect(h.forwarded()).toBe(1);
  });

  it.each(["handoff", "handoff-and-complete"])("another host's %s with it is refused before forwarding or closing the source", async (verb) => {
    h = harness();
    const source = await h.repo.create({ ...CREATE, nudge: false });
    const res = await h.post(`/api/queue/${source.qitemId}/${verb}`, { fromSession: "worker@rig-a", toSession: "dev@rig-b", hostId: "vps-b", claimOnWake: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("claim_on_wake_cross_host_unsupported");
    expect(h.forwarded()).toBe(0);
    expect(h.repo.getById(source.qitemId)?.state).toBe("pending");
  });
});
