// `rig queue create --id-only` (alias --quiet) prints only the confirmed row's ID on stdout. Before sending, stderr gets
// one short line with the request's ID; the full recovery guidance appears only when the outcome is unknown. A refusal,
// a warning and --verify's delivery receipt go to stderr, with today's exit statuses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { DaemonTimeoutError, SENDER_IDENTITY_HEADER, senderIdentityHeaders } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const ID = "qitem-20261126000000-0123456789abcdef";
const ROW = { qitemId: ID, destinationSession: "dev@rig", sourceSession: "lead@rig", body: "b", state: "pending" };

type Reply = { status: number; data: unknown } | Error;

describe("queue create --id-only", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-id-only-"));
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig");
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  /** Runs one create against a fake daemon: `post` answers the create (given the request body), `gets` the read-backs. */
  async function run(args: string[], post: (body: Record<string, unknown>) => Reply, gets: Record<string, Reply> = {}) {
    const posted: Array<Record<string, unknown>> = [];
    const answer = (reply: Reply) => { if (reply instanceof Error) throw reply; return reply; };
    const deps: QueueDeps = {
      deliveryVerify: { timeoutMs: 0, intervalMs: 0, sleep: async () => {} },
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: (base: string) => ({
        baseUrl: base,
        senderIdentity: async () => ({ session: senderIdentityHeaders()[SENDER_IDENTITY_HEADER], originUnknown: false }),
        get: vi.fn(async (p: string) => answer(gets[p] ?? { status: 404, data: { error: "qitem_not_found" } })),
        post: vi.fn(async (_p: string, body: Record<string, unknown>) => { posted.push(body); return answer(post(body)); }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    let error: unknown = null;
    try {
      await program.parseAsync(["node", "rig", "queue", "create", "--destination", "dev@rig", "--body", "b", "--summary", "s", ...args]);
    } catch (err) { error = err; }
    return { posted, error };
  }

  const created = (body: Record<string, unknown>): Reply => ({ status: 201, data: { ...ROW, qitemId: body.qitemId } });

  it.each(["--id-only", "--quiet"])("%s prints only the confirmed ID on stdout, after one short unconfirmed line on stderr", async (flag) => {
    const { posted, error } = await run([flag], created);
    expect(error).toBeNull();
    const id = posted[0]!.qitemId as string;
    expect(id).toMatch(/^qitem-\d{14}-[0-9a-f]{16}$/);
    expect(stdout).toEqual([id]);
    expect(stderr).toEqual([`Request ID (unconfirmed): ${id}`]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([["--json"], ["--full"]])("refuses to combine with %s before sending anything", async (flag) => {
    const { posted } = await run(["--id-only", flag], created);
    expect(posted).toEqual([]);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("id_only_format_conflict");
    expect(process.exitCode).toBe(1);
  });

  it("a refused create prints nothing on stdout and keeps its error and exit status", async () => {
    const { posted, error } = await run(["--id-only", "--id", ID], () => ({ status: 400, data: { error: "validation_error", message: "destination is required" } }));
    expect(error).toBeNull();
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("destination is required");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["no answer in time", new DaemonTimeoutError("Request to /api/queue/create timed out after 5000ms")],
    ["an unexpected error", new Error("socket hang up")],
  ])("an unknown outcome (%s) prints no ID on stdout, and stderr gives the request ID with the same-ID recovery", async (_case, failure) => {
    const { posted, error } = await run(["--id-only", "--id", ID], () => failure);
    expect(error).not.toBeNull();
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([]);
    const all = stderr.join("\n");
    expect(all).toContain(`Request ID (unconfirmed): ${ID}`);
    expect(all).toContain(`rig queue show '${ID}' --full --json`);
    expect(all).toContain(`repeat the same create with --id '${ID}'`);
  });

  it("a create that committed after the CLI stopped waiting prints its ID, read back by the same ID", async () => {
    const { posted, error } = await run(["--id-only", "--id", ID], () => new DaemonTimeoutError("Request to /api/queue/create timed out after 5000ms"),
      { [`/api/queue/${ID}`]: { status: 200, data: ROW } });
    expect(error).toBeNull();
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([ID]);
    expect(stderr.join("\n")).not.toContain("not proof of persistence");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a 2xx that names another row is read back once by the request's ID, and prints it only when that row is this create", async () => {
    const { posted, error } = await run(["--id-only", "--id", ID], () => ({ status: 201, data: { ...ROW, qitemId: "qitem-other" } }),
      { [`/api/queue/${ID}`]: { status: 200, data: ROW } });
    expect(error).toBeNull();
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([ID]);
    expect(stderr.join("\n")).toContain("The daemon answered 201 but named qitem-other");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a 2xx that names no row, with nothing read back, prints no ID and exits 1 with the same-ID recovery", async () => {
    const { posted, error } = await run(["--id-only", "--id", ID], () => ({ status: 200, data: {} }));
    expect(error).toBeNull();
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([]);
    const all = stderr.join("\n");
    expect(all).toContain("The daemon answered 200 but named no row");
    expect(all).toContain(`No row ${ID} yet`);
    expect(all).toContain(`repeat the same create with --id '${ID}'`);
    expect(process.exitCode).toBe(1);
  });

  it("--verify still prints the ID and exits 0 when delivery isn't confirmed, and says so on stderr", async () => {
    const { error } = await run(["--id-only", "--id", ID, "--verify"], created, { [`/api/queue/${ID}`]: { status: 200, data: ROW } });
    expect(error).toBeNull();
    expect(stdout).toEqual([ID]);
    expect(stderr.join("\n")).toMatch(/^Delivery: still-pending\. The qitem is saved\. .* Next: rig queue show /m);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a body-not-saved warning stays on stderr", async () => {
    const { error } = await run(["--id-only", "--id", ID], () => ({ status: 200, data: { ...ROW, body: "older body",
      createWarning: { code: "qitem_body_not_saved", message: "The supplied body was not saved." } } }));
    expect(error).toBeNull();
    expect(stdout).toEqual([ID]);
    expect(stderr.join("\n")).toContain("Warning: The supplied body was not saved.");
  });
});
