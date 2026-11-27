// Actual SDK dispatch and host routing, with inert clients: no HTTP/provider process.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function call(name: string, claimOnWake: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "review-wake-host-"));
  vi.stubEnv("QWB_REVIEW_REMOTE_TOKEN", "fixture-token");
  const local = new DaemonClient("http://127.0.0.1:9998"), remote = new DaemonClient("http://127.0.0.1:9999");
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  for (const client of [local, remote]) {
    client.get = vi.fn(async route => route === "/healthz" ? { status: 200, data: { selfHostId: "here" } } : { status: 404, data: {} }) as typeof client.get;
    client.post = vi.fn(async (route, raw) => {
      const body = raw as Record<string, unknown>; writes.push({ path: route, body });
      const row = { qitemId: body.qitemId ?? "qitem-successor", destinationSession: body.destinationSession ?? body.toSession, claimOnWake: body.claimOnWake };
      return { status: 201, data: route.endsWith("/handoff") ? { closed: { qitemId: "qitem-source", state: "handed-off" }, created: row } : row };
    }) as typeof client.post;
  }
  const server = createMcpServer(local, { seat: "lead@here", rostersFolder: () => home, presenceFile: () => path.join(home, "presence.json"),
    clientFactory: () => remote,
    hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "elsewhere", transport: "http", url: "http://127.0.0.1:9999", bearer_env: "QWB_REVIEW_REMOTE_TOKEN" }] } }),
    hostBindingsLoader: () => ({ version: 1, bindings: {} }),
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "review-wake-host", version: "1" });
  await server.connect(s); await mcp.connect(c);
  try {
    const args = name === "rig_queue_create"
      ? { destination: "worker@there", body: "work", qitemId: "qitem-request" }
      : { qitemId: "qitem-source", to: "worker@there", body: "work" };
    const result = await mcp.callTool({ name, arguments: { ...args, host: "elsewhere", ...(claimOnWake ? { claimOnWake: true } : {}) } });
    return { result, writes };
  } finally { await mcp.close(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

describe("MCP host opt-in refuses before the destination write", () => {
  it.each(["rig_queue_create", "rig_queue_handoff"])("%s cannot bypass the selected local-only boundary", async name => {
    const { result, writes } = await call(name, true);
    expect.soft(result.isError).toBe(true);
    expect.soft(writes).toEqual([]); // a post-write 'not kept' error is too late
    expect.soft(JSON.stringify(result)).toContain("claim_on_wake_cross_host_unsupported");
  });
  it("keeps the ordinary remote create route when opt-in is absent", async () => {
    const { result, writes } = await call("rig_queue_create", false);
    expect(result.isError).toBeFalsy();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).not.toHaveProperty("claimOnWake");
  });
});
