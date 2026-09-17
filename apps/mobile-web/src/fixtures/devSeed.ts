/**
 * Dev-only seeding — jump straight to any screen state, any API state, or both, without
 * a backend.
 *
 * Two independent dials, because the app's states come from two places:
 *   - `?seed=<scenario>` writes the zustand store (screen FSM, answer, skeleton).
 *   - `?api=<profile>` installs a mock tRPC handler (loading, error, facet counts,
 *     capacity gate) — the states react-query owns, which the store cannot reach.
 *
 * They compose: `?seed=search&api=theatre-search-error`. A scenario may also declare a
 * default profile; an explicit `?api=` wins over it. On native, `EXPO_PUBLIC_SEED` and
 * `EXPO_PUBLIC_API_PROFILE` stand in for the query params.
 *
 * Everything here is inert unless `__DEV__` is true. The scenario, fixture, and profile
 * modules are pulled in via dynamic `import()` so they stay out of the initial bundle.
 */
import { setDevTransportHandler } from "@/lib/devTransport";
import { useSeatfirstStore } from "@/store/seatfirstStore";

export const DEV_SEED_QUERY_PARAM = "seed";
export const DEV_API_QUERY_PARAM = "api";

/** Read through `globalThis` so this module needs no ambient `__DEV__` declaration. */
export function isDevSeedEnabled(): boolean {
  return (globalThis as { __DEV__?: boolean }).__DEV__ === true;
}

function locationSearch(): string | null {
  const location = (globalThis as { location?: { search?: string } }).location;
  return typeof location?.search === "string" ? location.search : null;
}

function readParam(param: string, envValue: string | undefined): string | null {
  const search = locationSearch();
  if (search !== null) {
    const fromUrl = new URLSearchParams(search).get(param);
    if (fromUrl !== null && fromUrl.length > 0) return fromUrl;
  }
  return typeof envValue === "string" && envValue.length > 0 ? envValue : null;
}

/**
 * Captured at module load, deliberately. expo-router rewrites the URL once it mounts and
 * drops query params it does not own, so reading `location.search` any later comes back
 * empty and the request would look absent.
 */
const initialSeedId: string | null = readParam(DEV_SEED_QUERY_PARAM, process.env.EXPO_PUBLIC_SEED);
const initialApiProfile: string | null = readParam(
  DEV_API_QUERY_PARAM,
  process.env.EXPO_PUBLIC_API_PROFILE,
);

/** The scenario id this session started with. */
export function readSeedId(): string | null {
  return initialSeedId;
}

/** The API profile this session started with, if one was named explicitly. */
export function readApiProfileId(): string | null {
  return initialApiProfile;
}

/**
 * Whether anything was requested that still needs applying. Callers use this to hold off
 * real bootstrap until the store is seeded and the mock transport is installed, so a
 * seeded screen never fires a network call it does not need.
 */
export function hasPendingDevSeed(): boolean {
  return isDevSeedEnabled() && (initialSeedId !== null || initialApiProfile !== null);
}

/**
 * Reflect the active dials in the URL without a reload, so refreshing keeps the state and
 * the link is shareable with a teammate. No-op off the web.
 */
export function writeDevParamsToUrl(params: { seed?: string | null; api?: string | null }): void {
  const history = (globalThis as { history?: { replaceState?: (...args: unknown[]) => void } })
    .history;
  const search = locationSearch();
  const pathname = (globalThis as { location?: { pathname?: string } }).location?.pathname;
  if (typeof history?.replaceState !== "function" || search === null) return;

  const next = new URLSearchParams(search);
  for (const [param, value] of [
    [DEV_SEED_QUERY_PARAM, params.seed],
    [DEV_API_QUERY_PARAM, params.api],
  ] as const) {
    if (value === undefined) continue;
    if (value === null) next.delete(param);
    else next.set(param, value);
  }
  const query = next.toString();
  history.replaceState({}, "", `${pathname ?? ""}${query.length > 0 ? `?${query}` : ""}`);
}

/**
 * Install (or clear, with null) the mock tRPC handler. Returns false for an unknown
 * profile name so a typo leaves the real transport alone rather than half-mocking it.
 */
export async function applyApiProfile(name: string | null): Promise<boolean> {
  if (!isDevSeedEnabled()) return false;
  const [{ queryClient }, { clearTheatreMovieCache }] = await Promise.all([
    import("@/lib/trpc"),
    import("@/hooks/useTheatreMovieSet"),
  ]);
  clearTheatreMovieCache();
  queryClient.clear();
  if (name === null) {
    setDevTransportHandler(null);
    return true;
  }
  const { createApiHandler, isApiProfileName } = await import("./mockTransport");
  if (!isApiProfileName(name)) return false;
  setDevTransportHandler(createApiHandler(name));
  return true;
}

/**
 * Apply a scenario by id, including whatever API profile it declares. Returns false for
 * an unknown id so the caller can leave the real app alone rather than half-seeding it.
 *
 * The store patch is applied over every slice's initial state, so switching scenarios
 * never leaves a stale answer or recheck result behind.
 */
export async function applyDevSeed(id: string): Promise<boolean> {
  if (!isDevSeedEnabled()) return false;
  const { findScenario, resetState } = await import("./scenarios");
  const scenario = findScenario(id);
  if (scenario === null) return false;
  const [{ queryClient }, { clearTheatreMovieCache }] = await Promise.all([
    import("@/lib/trpc"),
    import("@/hooks/useTheatreMovieSet"),
  ]);
  clearTheatreMovieCache();
  queryClient.clear();
  if (scenario.api !== undefined) await applyApiProfile(scenario.api);
  useSeatfirstStore.setState({ ...resetState(), ...scenario.state() });
  return true;
}

/**
 * Applies whatever the URL or env asked for. An explicit `?api=` is applied last so it
 * overrides the profile a scenario would otherwise install.
 */
export async function applySeedFromEnvironment(): Promise<{
  seed: string | null;
  api: string | null;
}> {
  if (!isDevSeedEnabled()) return { seed: null, api: null };
  const seed = initialSeedId !== null && (await applyDevSeed(initialSeedId)) ? initialSeedId : null;
  const api =
    initialApiProfile !== null && (await applyApiProfile(initialApiProfile))
      ? initialApiProfile
      : null;
  return { seed, api };
}
