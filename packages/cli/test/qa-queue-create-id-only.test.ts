// QA: `rig queue create --id-only` as a caller sees it. The compiled CLI runs as its own process against
// a stub daemon on a local port (busy-daemon-real-request.test.ts's shape), so streams, exit status and an uncatchable kill are real.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

const cliEntry = path.join(__dirname, "..", "dist", "index.js");

type Mode = "created" | "hang" | "drop" | "conflict" | "ignores-policy" | "missing-id" | "other-id";
interface Run { stdout: string; stderr: string; exit: number | null; signal: NodeJS.Signals | null; posted: Array<Record<string, unknown>> }

// A missing build would skip silently: fail instead, so a run without a fresh dist can't pass.
describe("QA: queue create --id-only (compiled CLI, stub daemon)", () => {
  let server: http.Server;
  let port: number;
  let mode: Mode = "created";
  const posted: Array<Record<string, unknown>> = [];
  const held = new Set<http.ServerResponse>();
  let onPost: (() => void) | undefined;
  let home: string;

  beforeAll(async () => {
    expect(fs.existsSync(cliEntry), `built CLI at ${cliEntry}`).toBe(true);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "qa-id-only-"));
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/healthz")) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        if (req.method === "POST" && url.startsWith("/api/queue/create")) {
          const body = JSON.parse(raw) as Record<string, unknown>;
          posted.push(body);
          onPost?.();
          if (mode === "hang") { held.add(res); return; }
          // The create may have committed, but its answer never arrives.
          if (mode === "drop") return void req.socket.destroy();
          if (mode === "conflict") {
            return void res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({
              code: "qitem_claim_on_wake_conflict", error: "stored claim policy differs", qitemId: body.qitemId, claimOnWake: false }));
          }
          // A 2xx that doesn't confirm this request: no ID, or another row's.
          const qitemId = mode === "missing-id" ? undefined : mode === "other-id" ? "qitem-20261126000000-00000000000000bb" : body.qitemId;
          const row = { qitemId, state: "pending", destinationSession: body.destinationSession,
            ...(mode === "ignores-policy" ? {} : { claimOnWake: body.claimOnWake ?? false }) };
          return void res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify(row));
        }
        // Reconcile-by-ID reads after a lost response find nothing.
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const res of held) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => { posted.length = 0; mode = "created"; onPost = undefined; });

  function start(args: string[]): { child: ChildProcess; done: Promise<Run> } {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_SESSION_NAME: "lead@build" };
    for (const key of ["RIGGED_HOME", "RIGGED_URL", "RIGGED_SESSION_NAME"]) delete env[key];
    const child = spawn(process.execPath, [cliEntry, "queue", "create", "--destination", "worker@build", "--summary", "s", "--body", "b", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += String(c); });
    child.stderr!.on("data", (c) => { stderr += String(c); });
    const done = new Promise<Run>((resolve) => child.on("close", (exit, signal) => resolve({ stdout, stderr, exit, signal, posted: [...posted] })));
    return { child, done };
  }
  const create = async (args: string[]) => { const r = await start(args).done; console.log(`qa-id-only ${JSON.stringify(args)} ${JSON.stringify(r)}`); return r; };

  for (const flag of ["--id-only", "--quiet"]) {
    it(`${flag}: a confirmed create prints exactly the persisted ID on stdout, and only the tiny unconfirmed request line on stderr`, async () => {
      const r = await create([flag]);
      expect(r.exit).toBe(0);
      expect(r.posted).toHaveLength(1);
      const id = String(r.posted[0]!.qitemId);
      expect(r.stdout).toBe(`${id}\n`);
      // This harness's empty OPENRIG_HOME has no durable instance identity, so the CLI also warns that origin is unknown; a
      // real seat's home has one. Nothing else may reach stderr.
      expect(r.stderr.split("\n").filter((l) => l && !l.startsWith("Origin instance unknown:"))).toEqual([`Request ID (unconfirmed): ${id}`]);
    }, 30_000);
  }

  for (const format of ["--json", "--full"]) {
    it(`--id-only with ${format} is refused locally: nothing is sent, no success ID`, async () => {
      const r = await create(["--id-only", format]);
      expect(r.exit).not.toBe(0);
      expect(r.posted).toEqual([]);
      expect(r.stdout).not.toMatch(/^qitem-\S+\n?$/);
      // Refused as a format conflict, not as an unknown option (which an older CLI also "refuses").
      expect(`${r.stdout}${r.stderr}`).not.toContain("unknown option");
      expect(`${r.stdout}${r.stderr}`).toContain(format);
    }, 30_000);
  }

  it("killed (SIGKILL) after the daemon received the create: the request ID already reached stderr, stdout is empty", async () => {
    mode = "hang";
    const run = start(["--id-only"]);
    // The kill waits for the daemon to have the create; a CLI that exits first is reported by the asserts below.
    const posted = new Promise<void>((resolve) => { onPost = resolve; });
    await Promise.race([posted, run.done]);
    run.child.kill("SIGKILL");
    const r = await run.done;
    console.log(`qa-id-only sigkill ${JSON.stringify(r)}`);
    expect(r.signal).toBe("SIGKILL");
    expect(r.posted).toHaveLength(1);
    expect(r.stderr).toContain(`Request ID (unconfirmed): ${String(r.posted[0]!.qitemId)}`);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("the answer to the create is lost: no success stdout, the same request ID and an unknown-write diagnostic on stderr", async () => {
    mode = "drop";
    const r = await create(["--id-only"]);
    expect(r.exit).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.posted.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(r.posted.map((p) => String(p.qitemId)));
    expect(ids.size).toBe(1); // any retry reuses the ID, never a new one
    const [id] = [...ids];
    expect(r.stderr).toContain(`Request ID (unconfirmed): ${id}`);
    // More than the tiny line: the full unknown-write receipt, never a claim of no effect.
    expect(r.stderr.split("\n").filter((l) => l.includes(id!)).length).toBeGreaterThanOrEqual(2);
    expect(r.stderr).not.toMatch(/not created|no effect/i);
  }, 60_000);

  for (const answer of ["missing-id", "other-id"] as const) {
    it(`a 2xx answer that doesn't confirm this ID (${answer}): no success stdout, the request ID stays unconfirmed`, async () => {
      mode = answer;
      const r = await create(["--id-only"]);
      expect(r.posted.length).toBeGreaterThanOrEqual(1);
      const id = String(r.posted[0]!.qitemId);
      expect(r.stdout).toBe("");
      expect(r.exit).not.toBe(0);
      expect(r.stderr).toContain(id);
      expect(`${r.stdout}${r.stderr}`).not.toContain("qitem-20261126000000-00000000000000bb\n");
    }, 60_000);
  }

  it("a changed claim policy on the same ID: 409 conflict, no success stdout, the stored policy is named", async () => {
    mode = "conflict";
    const r = await create(["--id-only", "--claim-on-wake", "--id", "qitem-20261126000000-00000000000000aa"]);
    expect(r.exit).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("qitem-20261126000000-00000000000000aa");
    expect(r.stderr).toMatch(/claim[_ -]on[_ -]wake/i);
  }, 30_000);

  it("an older endpoint that drops a requested claim-on-wake: known persisted, same ID, exit 1, no success stdout", async () => {
    mode = "ignores-policy";
    const r = await create(["--id-only", "--claim-on-wake"]);
    expect(r.posted).toHaveLength(1);
    expect(r.exit).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(String(r.posted[0]!.qitemId));
  }, 30_000);

  it("default output is unchanged: the existing pre-send request notice still prints", async () => {
    const r = await create([]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("Queue create request ID:");
  }, 30_000);
});
