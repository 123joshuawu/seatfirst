import { createConnection, type Socket } from "node:net";

import { afterAll, beforeAll, beforeEach, inject } from "vitest";

import type { RedisScript } from "../../src/redis.js";

type CommandPart = string | number | Buffer;
type RedisValue = string | number | null | RedisValue[];

interface Parsed {
  readonly value: RedisValue;
  readonly bytes: number;
}

function lineEnd(buffer: Buffer, offset: number): number {
  return buffer.indexOf("\r\n", offset);
}

function parseReply(buffer: Buffer, offset = 0): Parsed | undefined {
  if (buffer.length <= offset) return undefined;
  const type = String.fromCharCode(buffer[offset] ?? 0);
  const end = lineEnd(buffer, offset + 1);
  if (end < 0) return undefined;
  const header = buffer.toString("utf8", offset + 1, end);

  if (type === "+") return { value: header, bytes: end + 2 - offset };
  if (type === "-") throw new Error(`Redis: ${header}`);
  if (type === ":") return { value: Number(header), bytes: end + 2 - offset };
  if (type === "$") {
    const length = Number(header);
    if (length === -1) return { value: null, bytes: end + 2 - offset };
    const start = end + 2;
    const finish = start + length;
    if (buffer.length < finish + 2) return undefined;
    return { value: buffer.toString("utf8", start, finish), bytes: finish + 2 - offset };
  }
  if (type === "*") {
    const length = Number(header);
    if (length === -1) return { value: null, bytes: end + 2 - offset };
    const values: RedisValue[] = [];
    let cursor = end + 2;
    for (let i = 0; i < length; i++) {
      const item = parseReply(buffer, cursor);
      if (!item) return undefined;
      values.push(item.value);
      cursor += item.bytes;
    }
    return { value: values, bytes: cursor - offset };
  }
  throw new Error(`Unsupported Redis RESP type ${JSON.stringify(type)}`);
}

function encode(parts: readonly CommandPart[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

interface Pending {
  readonly resolve: (value: RedisValue) => void;
  readonly reject: (error: Error) => void;
}

/** Tiny RESP2 client: enough surface to execute the durability Lua protocols, no mocks. */
export class RedisClient {
  readonly #socket: Socket;
  readonly #allowFlushAll: boolean;
  readonly #pending: Pending[] = [];
  #buffer = Buffer.alloc(0);
  #chain: Promise<RedisValue> = Promise.resolve("OK");

  private constructor(socket: Socket, allowFlushAll: boolean) {
    this.#socket = socket;
    this.#allowFlushAll = allowFlushAll;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    socket.on("error", (error) => {
      for (const pending of this.#pending.splice(0)) pending.reject(error);
    });
  }

  static async connect(connectionString: string, allowFlushAll = false): Promise<RedisClient> {
    const url = new URL(connectionString);
    const port = Number(url.port || 6379);
    const socket = createConnection({ host: url.hostname, port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new RedisClient(socket, allowFlushAll);
    if (url.password) {
      const password = decodeURIComponent(url.password);
      if (url.username) await client.command("AUTH", decodeURIComponent(url.username), password);
      else await client.command("AUTH", password);
    }
    const database = Number(url.pathname.slice(1) || 0);
    if (database !== 0) await client.command("SELECT", database);
    return client;
  }

  #drain(): void {
    while (this.#pending.length > 0) {
      let parsed: Parsed | undefined;
      try {
        parsed = parseReply(this.#buffer);
      } catch (error) {
        const pending = this.#pending.shift();
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
        const end = lineEnd(this.#buffer, 1);
        this.#buffer = end < 0 ? Buffer.alloc(0) : this.#buffer.subarray(end + 2);
        continue;
      }
      if (!parsed) return;
      this.#buffer = this.#buffer.subarray(parsed.bytes);
      this.#pending.shift()?.resolve(parsed.value);
    }
  }

  command(...parts: readonly CommandPart[]): Promise<RedisValue> {
    if (String(parts[0]).toUpperCase() === "FLUSHALL" && !this.#allowFlushAll) {
      throw new Error(
        "Redis FLUSHALL is disabled for this client; use a disposable server and grant it explicitly",
      );
    }
    const run = (): Promise<RedisValue> =>
      new Promise((resolve, reject) => {
        this.#pending.push({ resolve, reject });
        this.#socket.write(encode(parts));
      });
    const result = this.#chain.then(run, run);
    this.#chain = result;
    return result;
  }

  async eval(
    script: RedisScript,
    keys: readonly string[],
    args: readonly CommandPart[],
  ): Promise<RedisValue> {
    return this.command("EVAL", script.text, keys.length, ...keys, ...args);
  }

  async scriptLoad(script: RedisScript): Promise<string> {
    return String(await this.command("SCRIPT", "LOAD", script.text));
  }

  async hget(key: string, field: string): Promise<string | null> {
    const value = await this.command("HGET", key, field);
    return value === null ? null : String(value);
  }

  async hset(key: string, values: Readonly<Record<string, CommandPart>>): Promise<number> {
    const fields = Object.entries(values).flatMap(([field, value]) => [field, value]);
    return Number(await this.command("HSET", key, ...fields));
  }

  async xadd(
    key: string,
    id: string,
    fields: Readonly<Record<string, CommandPart>>,
  ): Promise<string> {
    const values = Object.entries(fields).flatMap(([field, value]) => [field, value]);
    return String(await this.command("XADD", key, id, ...values));
  }

  async xrange(key: string, start: string, end: string): Promise<RedisValue[]> {
    const value = await this.command("XRANGE", key, start, end);
    return Array.isArray(value) ? value : [];
  }

  async rename(from: string, to: string): Promise<void> {
    const result = await this.command("RENAME", from, to);
    if (result !== "OK") throw new Error(`Redis RENAME returned ${JSON.stringify(result)}`);
  }

  async flushAll(): Promise<void> {
    const result = await this.command("FLUSHALL");
    if (result !== "OK") throw new Error(`Redis FLUSHALL returned ${JSON.stringify(result)}`);
  }

  async close(): Promise<void> {
    await this.#chain.catch(() => undefined);
    if (!this.#socket.destroyed) {
      await new Promise<void>((resolve) => {
        this.#socket.once("close", resolve);
        this.#socket.end();
      });
    }
  }
}

/** One flushed Redis database per test file; tests themselves remain independent. */
export function useRedis(): () => RedisClient {
  let redis: RedisClient | undefined;

  beforeAll(async () => {
    redis = await RedisClient.connect(inject("redisUrl"), inject("redisFlushAllAllowed"));
  });

  beforeEach(async () => {
    await redis?.flushAll();
  });

  afterAll(async () => {
    await redis?.close();
    redis = undefined;
  });

  return () => {
    if (!redis) throw new Error("useRedis() accessed outside a test");
    return redis;
  };
}
