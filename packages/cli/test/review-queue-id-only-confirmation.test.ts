import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProgram } from "../src/index.js";
import type { QueueDeps } from "../src/commands/queue.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

const ID = "qitem-review-confirmed-id";
const ROW = { qitemId: ID, sourceSession: "lead@rig", destinationSession: "dev@rig", body: "work", state: "pending" };
describe("id-only stdout requires confirmation of this request", () => {
  let home: string, stdout: string[], stderr: string[];
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "review-id-confirmation-"));
    vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig");
    stdout = []; stderr = []; process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => { stdout.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { stderr.push(args.join(" ")); });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); process.exitCode = undefined;
  });
  async function run(reply: Record<string, unknown>, recovered = false, claimOnWake = false) {
    const posts = vi.fn(async () => ({ status: 201, data: reply }));
    const gets = vi.fn(async () => recovered ? { status: 200, data: ROW } : { status: 404, data: { error: "qitem_not_found" } });
    const deps: QueueDeps = { lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: base => ({ baseUrl: base, post: posts, get: gets,
        senderIdentity: async () => ({ session: "lead@rig", originUnknown: false }) }) as unknown as ReturnType<QueueDeps["clientFactory"]> };
    const program = createProgram({ queueDeps: deps }); program.exitOverride();
    let error: unknown;
    try { await program.parseAsync(["node", "rig", "queue", "create", "--destination", "dev@rig", "--body", "work", "--id", ID, "--id-only", ...(claimOnWake ? ["--claim-on-wake"] : [])]); }
    catch (caught) { error = caught; }
    return { posts, gets, error };
  }
  it.each([{}, { ...ROW, qitemId: "qitem-another-request" }])("does not turn an uncorrelated 2xx into a success ID: %j", async reply => {
    const result = await run(reply);
    expect.soft(result.posts).toHaveBeenCalledTimes(1);
    expect.soft(stdout).toEqual([]);
    expect.soft(stderr.join("\n")).toContain(`rig queue show '${ID}'`);
    expect.soft(Boolean(result.error) || Number(process.exitCode ?? 0) !== 0).toBe(true);
  });
  it("can recover a malformed success reply by reading the original ID once, without another create", async () => {
    const result = await run({}, true);
    expect(result.posts).toHaveBeenCalledTimes(1);
    expect(result.gets).toHaveBeenCalledWith(`/api/queue/${ID}`, expect.anything());
    expect(stdout).toEqual([ID]);
    expect(process.exitCode ?? 0).toBe(0);
  });
  it.each([{}, { ...ROW, qitemId: "qitem-another-request" }])("claim-on-wake doesn't skip exact-ID confirmation/recovery for an uncorrelated 2xx: %j", async reply => {
    const result = await run(reply, false, true);
    expect.soft(result.posts).toHaveBeenCalledTimes(1);
    expect.soft(result.gets).toHaveBeenCalledWith(`/api/queue/${ID}`, expect.anything());
    expect.soft(stdout).toEqual([]);
    expect.soft(stderr.join("\n")).toContain(`rig queue show '${ID}'`);
    expect.soft(stderr.join("\n")).not.toContain("Row qitem-another-request was saved");
    expect.soft(Boolean(result.error) || Number(process.exitCode ?? 0) !== 0).toBe(true);
  });
});
