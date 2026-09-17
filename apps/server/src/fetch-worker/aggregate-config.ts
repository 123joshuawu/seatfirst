/**
 * `AnswerAssemblerDeps` environment reader (S29.3). The fetch-worker composes the real
 * AGGREGATE dispatch handler (S27) via `withAnswerAssembler`, which needs its own pg pool,
 * a `providerHostAllowlists` structured-config value, and the ADR-0023-fixed
 * `offerStalenessMs`. Every value is required and has no hardcoded default (gate 14 /
 * ADR 0006); the one ADR-0023-fixed value (120000 ms) is operator-injected, never
 * defaulted here — this module documents its NAME, not its value.
 *
 * - `DATABASE_URL`                            — Postgres connection string (assembler pool).
 * - `AGGREGATE_PG_POOL_MAX`                   — assembler pool size.
 * - `AGGREGATE_PG_POOL_IDLE_TIMEOUT_MS`       — assembler pool idle timeout.
 * - `AGGREGATE_PG_POOL_CONNECT_TIMEOUT_MS`    — assembler pool connect timeout.
 * - `AGGREGATE_PROVIDER_HOST_ALLOWLISTS_JSON` — `Record<string, string[]>` (S28's
 *   structured-config convention: a JSON string in one env var, shape-validated against
 *   `@seatfirst/core`'s `ResultContractConfigSchema`).
 * - `AGGREGATE_OFFER_STALENESS_MS`            — ADR 0023 decision 7 = 120000, injected.
 *
 * The pool is a second, assembler-owned pool: `startDispatchWorker` opens its own from the
 * `DISPATCH_PG_POOL_*` family and does not expose it, and `AnswerAssemblerDeps.pool` must
 * be a dedicated pool for `withTransaction` (single-connection brand, S27.3).
 */
import { ResultContractConfigSchema } from "@seatfirst/core";
import { createPool } from "@seatfirst/durability";

import type { AnswerAssemblerDeps } from "../dispatch/handlers/aggregate-answer-assembler.js";

export function answerAssemblerDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnswerAssemblerDeps {
  return {
    pool: createPool({
      connectionString: requiredString(env, "DATABASE_URL"),
      max: positiveInteger(env, "AGGREGATE_PG_POOL_MAX"),
      idleTimeoutMillis: positiveInteger(env, "AGGREGATE_PG_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: positiveInteger(env, "AGGREGATE_PG_POOL_CONNECT_TIMEOUT_MS"),
    }),
    providerHostAllowlists: ResultContractConfigSchema.parse({
      providerHostAllowlists: jsonObject(env, "AGGREGATE_PROVIDER_HOST_ALLOWLISTS_JSON"),
    }).providerHostAllowlists,
    offerStalenessMs: positiveInteger(env, "AGGREGATE_OFFER_STALENESS_MS"),
  };
}

function jsonObject(env: NodeJS.ProcessEnv, name: string): unknown {
  const raw = requiredString(env, name);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON, got ${JSON.stringify(raw)}`);
  }
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default (gate 14)`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredString(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
