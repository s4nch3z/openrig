import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/index.js";
import type { QueueDeps } from "../src/commands/queue.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

const ID = "qitem-review-unknown-http";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

describe("id-only keeps recovery for an HTTP error that does not prove no write", () => {
  it.each(["--id-only", "--quiet"])("%s names the original request and full same-ID recovery on a generic HTTP500", async flag => {
    const home = mkdtempSync(join(tmpdir(), "review-id-http-"));
    vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_SESSION_NAME", "lead@rig");
    const stdout: string[] = [], stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { stdout.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { stderr.push(args.join(" ")); });
    const post = vi.fn(async () => ({ status: 500, data: { error: "internal_error", message: "response failed after persistence" } }));
    const deps: QueueDeps = { lifecycleDeps: {} as QueueDeps["lifecycleDeps"], clientFactory: base => ({ baseUrl: base, post,
      get: vi.fn(async () => ({ status: 404, data: { error: "qitem_not_found" } })),
      senderIdentity: async () => ({ session: "lead@rig", originUnknown: false }),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]> };
    try {
      const program = createProgram({ queueDeps: deps }); program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "create", "--destination", "dev@rig", "--body", "work", "--id", ID, flag]);
      expect(post).toHaveBeenCalledTimes(1);
      expect(stdout).toEqual([]);
      expect(process.exitCode).toBe(2);
      expect(stderr.join("\n")).toContain(`Request ID (unconfirmed): ${ID}`);
      expect(stderr.join("\n")).toContain(`rig queue show '${ID}' --full --json`);
      expect(stderr.join("\n")).toContain(`repeat the same create with --id '${ID}'`);
      expect(stderr.join("\n")).not.toContain("No row was created");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
