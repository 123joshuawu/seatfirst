/**
 * Environment-sourced Mapbox geocoding config (S51, ADR 0045 §2, gate 14).
 *
 * The only tunable is the Mapbox access token — a static, env-file-supplied
 * string, required with no hardcoded default (gate 14 / ADR 0006,
 * `docs/gates.md:1-5`), mirroring `apps/server/src/tmdb/config.ts:12-26` and
 * `apps/server/src/app-config.ts:330`.
 *
 * The token-bucket numbers (750/12.5, ADR 0045 §2a) are deliberately NOT here:
 * they are ADR-pinned literals hard-coded in `token-bucket.ts`, exactly as
 * S25 hard-codes its ADR-0019 cadence rather than exposing it as a
 * configurable env tunable.
 */

export interface MapboxConfig {
  readonly accessToken: string;
}

export function parseMapboxConfig(env: NodeJS.ProcessEnv = process.env): MapboxConfig {
  return { accessToken: requiredString(env, "MAPBOX_ACCESS_TOKEN") };
}

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required and has no default (gate 14)`);
  }
  return value;
}
