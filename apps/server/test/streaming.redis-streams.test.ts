import { beforeEach, describe, expect, it, vi } from "vitest";

import { openSearchStreamReader, searchStreamKey } from "../src/streaming/redisStreams.js";

/**
 * S38.4 — the Redis Stream reader's own logic against a stubbed ioredis client: reply
 * flattening, block-timeout handling, and disconnect-based close. No live Redis —
 * connectivity-shaped concerns are `queue.redis.test.ts`'s territory.
 */

const state = vi.hoisted(() => {
  const clients: {
    url: unknown;
    options: unknown;
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    xread: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  return { clients };
});

vi.mock("ioredis", () => ({
  default: {
    Redis: class {
      url: unknown;
      options: unknown;
      on = vi.fn();
      connect = vi.fn(() => Promise.resolve());
      xread = vi.fn();
      quit = vi.fn();
      disconnect = vi.fn();
      constructor(url: string, options: Record<string, unknown>) {
        this.url = url;
        this.options = options;
        state.clients.push(this);
      }
    },
  },
}));

function lastClient() {
  const client = state.clients.at(-1);
  if (client === undefined) throw new Error("no ioredis client was constructed");
  return client;
}

beforeEach(() => {
  state.clients.length = 0;
});

describe("searchStreamKey", () => {
  it("prefixes the search id with `search:`", () => {
    expect(searchStreamKey("s")).toBe("search:s");
    expect(searchStreamKey("01JABCDEF")).toBe("search:01JABCDEF");
  });
});

describe("openSearchStreamReader", () => {
  it("opens a dedicated lazily-connecting client for the given URL", () => {
    openSearchStreamReader("redis://reader.example.invalid:6379");
    const client = state.clients[0];
    expect(client).toBeDefined();
    expect(client?.url).toBe("redis://reader.example.invalid:6379");
    expect(client?.options).toEqual({ lazyConnect: true });
    expect(client?.connect).not.toHaveBeenCalled();
  });

  it("yields null on a block timeout (xread → null) without throwing", async () => {
    const reader = openSearchStreamReader("redis://reader.example.invalid:6379");
    const client = lastClient();
    client.xread.mockResolvedValue(null);

    await expect(reader.readBlocked("search:s", "4-0", 15_000)).resolves.toBeNull();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.xread).toHaveBeenCalledWith("BLOCK", 15_000, "STREAMS", "search:s", "4-0");
  });

  it("flattens ioredis's flat [id, [k1, v1, k2, v2]] replies into fields records in order", async () => {
    const reader = openSearchStreamReader("redis://reader.example.invalid:6379");
    const client = lastClient();
    client.xread.mockResolvedValue([
      [
        "search:s",
        [
          ["1-0", ["type", "PROGRESS", "payload", '{"step":1}']],
          ["2-0", ["type", "COMPLETE", "payload", "null"]],
        ],
      ],
    ]);

    await expect(reader.readBlocked("search:s", "0-0", 1_000)).resolves.toEqual([
      { id: "1-0", fields: { type: "PROGRESS", payload: '{"step":1}' } },
      { id: "2-0", fields: { type: "COMPLETE", payload: "null" } },
    ]);
  });

  it("handles an odd-length field array without throwing, keeping the paired prefix", async () => {
    const reader = openSearchStreamReader("redis://reader.example.invalid:6379");
    const client = lastClient();
    client.xread.mockResolvedValue([["search:s", [["9-0", ["type", "PROGRESS", "dangling"]]]]]);

    await expect(reader.readBlocked("search:s", "0-0", 1_000)).resolves.toEqual([
      { id: "9-0", fields: { type: "PROGRESS" } },
    ]);
  });

  it("closes via disconnect(), never quit(), so an in-flight blocked read cannot hang shutdown", () => {
    const reader = openSearchStreamReader("redis://reader.example.invalid:6379");
    const client = lastClient();

    reader.close();

    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.quit).not.toHaveBeenCalled();
  });
});
