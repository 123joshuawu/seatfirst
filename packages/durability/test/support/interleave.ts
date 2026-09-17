import type { Client } from "pg";

import type { Db } from "./pg.js";

interface BarrierState {
  readonly key: number;
  readonly reached: Promise<void>;
  arrive: () => void;
  released: boolean;
}

function advisoryKey(name: string): number {
  let hash = 2166136261;
  for (const byte of Buffer.from(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash & 0x7fff_ffff;
}

/**
 * Deterministic two-connection barriers. The controller holds named advisory locks; a
 * side announces arrival and blocks in Postgres until the scripted release.
 */
export class Interleaver {
  readonly #control: Client;
  readonly #barriers = new Map<string, BarrierState>();

  private constructor(control: Client) {
    this.#control = control;
  }

  static async create(db: Db, names: readonly string[]): Promise<Interleaver> {
    const control = await db.connect();
    const interleaver = new Interleaver(control);
    for (const name of names) {
      let arrive = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const state = { key: advisoryKey(name), reached, arrive, released: false };
      interleaver.#barriers.set(name, state);
      await control.query(`SELECT pg_advisory_lock($1)`, [state.key]);
    }
    return interleaver;
  }

  #barrier(name: string): BarrierState {
    const barrier = this.#barriers.get(name);
    if (!barrier) throw new Error(`Unknown interleaving barrier ${name}`);
    return barrier;
  }

  async at(client: Client, name: string): Promise<void> {
    const barrier = this.#barrier(name);
    barrier.arrive();
    await client.query(`SELECT pg_advisory_lock($1)`, [barrier.key]);
    await client.query(`SELECT pg_advisory_unlock($1)`, [barrier.key]);
  }

  reached(name: string): Promise<void> {
    return this.#barrier(name).reached;
  }

  async release(name: string): Promise<void> {
    const barrier = this.#barrier(name);
    const result = await this.#control.query<{ unlocked: boolean }>(
      `SELECT pg_advisory_unlock($1) AS unlocked`,
      [barrier.key],
    );
    if (!result.rows[0]?.unlocked) throw new Error(`Barrier ${name} was not held`);
    barrier.released = true;
  }

  async backendPid(client: Client): Promise<number> {
    const pid = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    const target = pid.rows[0]?.pid;
    if (!target) throw new Error("Could not read interleaving backend pid");
    return target;
  }

  /** Wait until Postgres, not the JS scheduler, confirms this backend is lock-blocked. */
  async waitUntilBlocked(target: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const state = await this.#control.query<{ wait_event_type: string | null }>(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [target],
      );
      if (state.rows[0]?.wait_event_type === "Lock") return;
    }
    throw new Error(`Backend ${target} never reached a lock wait`);
  }

  async close(): Promise<void> {
    for (const [name, barrier] of this.#barriers) {
      if (!barrier.released) await this.release(name);
    }
  }
}
