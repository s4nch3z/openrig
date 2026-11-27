// rig_queue_create and rig_queue_handoff carry claimOnWake to the daemon only when asked, and a 2xx whose item doesn't
// show it kept (an older daemon) is an error naming the saved item, so the caller doesn't write it again.
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";

const folders: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of folders.splice(0)) fs.rmSync(f, { recursive: true, force: true }); });

async function connect(keeps: boolean, extra: Partial<Parameters<typeof createMcpServer>[1]> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-claim-on-wake-"));
  folders.push(folder);
  const get = vi.fn(async (p: string): Promise<DaemonResponse> => p === "/healthz" ? { status: 200, data: { selfHostId: "host-a" } } : { status: 404, data: {} });
  const post = vi.fn(async (route: string, body?: unknown): Promise<DaemonResponse> => {
    const sent = (body ?? {}) as Record<string, unknown>;
    const kept = keeps && sent.claimOnWake === true ? { claimOnWake: true } : {};
    if (route === "/api/queue/create") return { status: 201, data: { qitemId: sent.qitemId, state: "pending", destinationSession: sent.destinationSession, ...kept } };
    if (route.endsWith("/handoff")) return { status: 201, data: { closed: { qitemId: "qitem-held", state: "handed-off" },
      created: { qitemId: "qitem-next", destinationSession: sent.toSession, state: "pending", ...kept } } };
    return { status: 404, data: {} };
  });
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = get;
  client.post = post as typeof client.post;
  const server = createMcpServer(client, { rostersFolder: () => folder, presenceFile: () => path.join(folder, "presence.json"), seat: "lead@team", ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "claim-on-wake", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    await mcp.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, any> };
  return { post, call, close: async () => { await mcp.close(); await server.close(); } };
}

describe("MCP queue claimOnWake", () => {
  it("rig_queue_create sends it only when asked, and succeeds when the daemon keeps it", async () => {
    const m = await connect(true);
    try {
      expect((await m.call("rig_queue_create", { destination: "dev@team", body: "b", qitemId: "qitem-plain" })).isError).toBeFalsy();
      expect(m.post.mock.calls[0]![1]).not.toHaveProperty("claimOnWake");
      const kept = await m.call("rig_queue_create", { destination: "dev@team", body: "b", qitemId: "qitem-kept", claimOnWake: true });
      expect(kept.isError).toBeFalsy();
      expect(m.post.mock.calls[1]![1]).toMatchObject({ claimOnWake: true });
    } finally { await m.close(); }
  });

  it("rig_queue_create: a daemon that didn't keep it is an error naming the saved item, after one write", async () => {
    const m = await connect(false);
    try {
      const result = await m.call("rig_queue_create", { destination: "dev@team", body: "b", qitemId: "qitem-old", claimOnWake: true });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, code: "claim_on_wake_not_kept", qitemId: "qitem-old" });
      expect(m.post).toHaveBeenCalledTimes(1);
    } finally { await m.close(); }
  });

  it.each([true, false])("rig_queue_handoff sends it for the new item (kept=%s)", async (keeps) => {
    const m = await connect(keeps);
    try {
      const result = await m.call("rig_queue_handoff", { qitemId: "qitem-held", to: "qa@team", claimOnWake: true });
      expect(m.post.mock.calls.at(-1)![1]).toMatchObject({ toSession: "qa@team", claimOnWake: true });
      if (keeps) expect(result.isError).toBeFalsy();
      else expect(result.structuredContent).toMatchObject({ ok: false, code: "claim_on_wake_not_kept", qitemId: "qitem-next" });
    } finally { await m.close(); }
  });

  it.each(["rig_queue_create", "rig_queue_handoff"])("%s with a host and claimOnWake is refused before anything is sent; without it, it goes to that host", async (tool) => {
    process.env.CLAIM_ON_WAKE_HOST_TOKEN = "tok";
    onTestFinished(() => { delete process.env.CLAIM_ON_WAKE_HOST_TOKEN; });
    const remote = new DaemonClient("http://127.0.0.1:17433");
    remote.get = vi.fn(async () => ({ status: 200, data: {} }));
    remote.post = vi.fn(async () => ({ status: 201, data: { qitemId: "qitem-remote", created: { qitemId: "qitem-remote" } } })) as typeof remote.post;
    const m = await connect(true, {
      clientFactory: () => remote,
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vps-b", transport: "http", url: "http://127.0.0.1:17433", bearer_env: "CLAIM_ON_WAKE_HOST_TOKEN" }] } }) as never,
      hostBindingsLoader: () => ({ version: 1, bindings: {} }),
    });
    try {
      const args = tool === "rig_queue_create" ? { destination: "dev@rig-b", body: "b", qitemId: "qitem-x", host: "vps-b" } : { qitemId: "qitem-held", to: "dev@rig-b", host: "vps-b" };
      const refused = await m.call(tool, { ...args, claimOnWake: true });
      expect(refused.structuredContent).toMatchObject({ ok: false, code: "claim_on_wake_cross_host_unsupported" });
      expect(remote.post).not.toHaveBeenCalled();
      expect(m.post).not.toHaveBeenCalled();
      await m.call(tool, args);
      expect(remote.post).toHaveBeenCalledTimes(1);
    } finally { await m.close(); }
  });
});
