/**
 * Environment-sourced TMDB worker config (S25.5, ADR 0019 amendment decision 4).
 *
 * The only tunable is the TMDB Bearer API key — a static, env-file-supplied string,
 * required with no hardcoded default (gate 14 / ADR 0006, `docs/gates.md:1-5`), mirroring
 * `apps/server/src/relay/entrypoint.ts:30-56`. The token-bucket numbers (30/30, decision 3)
 * and the cron time (04:00 `America/New_York`, decision 1) are deliberately NOT here: they
 * are ADR-pinned literals hard-coded in `token-bucket.ts` and `due.ts` respectively, exactly
 * as S26 hard-codes its ADR-0022 cadence in `due.ts`/`crawl.ts` rather than exposing it as
 * a configurable env tunable.
 */
export interface TmdbConfig {
  readonly apiKey: string;
}

export function tmdbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TmdbConfig {
  return { apiKey: requiredString(env, "TMDB_API_KEY") };
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default (gate 14)`);
  }
  return value;
}
