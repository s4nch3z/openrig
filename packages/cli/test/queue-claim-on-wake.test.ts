// `--claim-on-wake` on rig queue create / handoff / handoff-and-complete asks for the row (or the new row) to be claimed
// by the wake that carries its complete body. The CLI sends the flag only when given, and a 2xx whose row doesn't show it
// kept (an older daemon) is reported with the saved row's ID, exit 1 and no success output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { SENDER_IDENTITY_HEADER, senderIdentityHeaders } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const ID = "qitem-20261126000000-0123456789abcdef";
const NEW_ID = "qitem-20261126000001-fedcba9876543210";
const ROW = { qitemId: ID, destinationSession: "dev@rig", sourceSession: "lead@rig", body: "b", state: "pending" };

describe("queue --claim-on-wake", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-claim-on-wake-"));
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

  async function run(args: string[], reply: (body: Record<string, unknown>) => { status: number; data: unknown }) {
    const posted: Array<Record<string, unknown>> = [];
    const deps: QueueDeps = {
      deliveryVerify: { timeoutMs: 0, intervalMs: 0, sleep: async () => {} },
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: (base: string) => ({
        baseUrl: base,
        senderIdentity: async () => ({ session: senderIdentityHeaders()[SENDER_IDENTITY_HEADER], originUnknown: false }),
        get: vi.fn(async () => ({ status: 404, data: { error: "qitem_not_found" } })),
        post: vi.fn(async (_p: string, body: Record<string, unknown>) => { posted.push(body); return reply(body); }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", ...args]);
    return posted;
  }
  const create = (extra: string[], reply: (body: Record<string, unknown>) => { status: number; data: unknown }) =>
    run(["create", "--destination", "dev@rig", "--body", "b", "--summary", "s", "--id", ID, ...extra], reply);

  it("create sends claimOnWake only when asked", async () => {
    const plain = await create([], () => ({ status: 201, data: ROW }));
    expect(plain[0]).not.toHaveProperty("claimOnWake");
    const asked = await create(["--claim-on-wake", "--id-only"], () => ({ status: 201, data: { ...ROW, claimOnWake: true } }));
    expect(asked[0]!.claimOnWake).toBe(true);
    expect(stdout.at(-1)).toBe(ID);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([[[]], [["--id-only"]], [["--json"]]])("create %j: a daemon that didn't keep it gets the saved ID on stderr, exit 1, no stdout", async (extra) => {
    const posted = await create(["--claim-on-wake", ...extra], () => ({ status: 201, data: ROW }));
    expect(posted).toHaveLength(1);
    expect(stdout).toEqual([]);
    const all = stderr.join("\n");
    expect(all).toContain("claim_on_wake_not_kept");
    expect(all).toContain(ID);
    expect(all).toContain("waits for a manual claim");
    expect(process.exitCode).toBe(1);
  });

  it("create: a same-ID retry that changes it is refused with the stored policy and the ID, no stdout", async () => {
    await create(["--claim-on-wake", "--id-only"], () => ({ status: 409, data: { error: "qitem_claim_on_wake_conflict",
      message: `qitem ${ID} already exists with claimOnWake false; a retry can't change it to true.`, qitemId: ID, storedClaimOnWake: false, requestedClaimOnWake: true } }));
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("qitem_claim_on_wake_conflict");
    expect(stderr.join("\n")).toContain(ID);
    expect(process.exitCode).toBe(1);
  });

  it.each(["handoff", "handoff-and-complete"])("%s sends it for the new row, and names that row when it wasn't kept", async (verb) => {
    const posted = await run([verb, ID, "--to", "qa@rig", "--summary", "s", "--claim-on-wake"],
      () => ({ status: 200, data: { closed: { ...ROW, state: "handed-off" }, created: { ...ROW, qitemId: NEW_ID, destinationSession: "qa@rig" } } }));
    expect(posted[0]!.claimOnWake).toBe(true);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(`claim_on_wake_not_kept: The handoff completed, and its new row ${NEW_ID} was saved`);
    expect(process.exitCode).toBe(1);
  });

  it("handoff with it kept prints as usual", async () => {
    await run(["handoff", ID, "--to", "qa@rig", "--summary", "s", "--claim-on-wake", "--json"],
      () => ({ status: 200, data: { closed: { ...ROW, state: "handed-off" }, created: { ...ROW, qitemId: NEW_ID, claimOnWake: true } } }));
    expect(stdout.join("\n")).toContain(NEW_ID);
    expect(stderr.join("\n")).not.toContain("claim_on_wake_not_kept");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
