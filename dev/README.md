# Local dev backend

Run the real backend locally against realistic AMC-shaped data. AMC traffic is **fixture-
only by default** (zero live traffic); real AMC traffic is available as an explicit opt-in
(`AMC_LIVE_FETCH`, see "Real AMC fetches" below). Two structural modes, one Compose file
(`docker-compose.dev.yml` at the repo root).

**Iterating on UI rather than backend behaviour? You probably need none of this** — see
"No backend at all" directly below. See `dev/fixtures/amc/README.md` for what the
seeded data actually is and why it's safe/synthetic. If you're running more than one
instance of this stack on the same machine, see `docker-compose.dev.yml`'s header comment
for the coexistence rules.

## No backend at all — seeded UI states

For working on screens and styles, the Docker stack is usually more setup than the task
needs. `apps/mobile-web` can put itself into any screen or API state on its own:

```bash
pnpm --filter @seatfirst/mobile-web dev   # then open with a seed:
#   http://localhost:8081/?seed=result-hedged
#   http://localhost:8081/?seed=search&api=theatre-search-error
```

Two independent dials, because the app's states come from two places:

| Dial            | Query param   | Native env var            | Writes                                                             |
| --------------- | ------------- | ------------------------- | ------------------------------------------------------------------ |
| Screen scenario | `?seed=<id>`  | `EXPO_PUBLIC_SEED`        | The zustand store — screen FSM, answer, schedule skeleton          |
| API profile     | `?api=<name>` | `EXPO_PUBLIC_API_PROFILE` | A mock tRPC handler — loading, errors, facet counts, capacity gate |

They compose, and a scenario may declare a default profile; an explicit `?api=` overrides
it. A dev-only bar at the bottom of the screen lists both sets, and picking from it
rewrites the query string so a reload keeps the state and the link is shareable. The bar
starts collapsed when neither dial was requested, so it stays out of the way during
ordinary dev work against a live backend.

Everything here is inert unless `__DEV__` is true, and the scenario/fixture/profile
modules load through dynamic `import()`, so none of it reaches the initial bundle.

### Screen scenarios (`?seed=`)

`search`, `search-empty`, `checking`, `checking-reconnect`, `result-confident`,
`result-hedged`, `result-empty`, `result-deferred`, `partial`, `halted`, `recheck`,
`recheck-unavailable`, `replacement`, `confirmed`, plus the `form-*` set below.

The screen FSM crossed with the search status/answer/skeleton is the expensive thing to
reach by hand; these land on it directly. Defined in
`apps/mobile-web/src/fixtures/scenarios.ts`.

### API profiles (`?api=`)

`happy`, `theatre-search-loading`, `theatre-search-empty`, `theatre-search-error`,
`movies-loading`, `movies-empty`, `movies-error`, `facets-partial`, `facets-cold`,
`facets-warm-zero`, `capacity-blocked`, `capacity-unavailable`, `admission-rejected`,
`offline`.

These reach what the store cannot: the search form's async states live in react-query and
in bare `trpcClient` calls, not in zustand. The `form-*` scenarios pair a store state with
the profile that exercises it — `form-theatre-error`, `form-facets-cold`,
`form-capacity-blocked`, `form-admission-rejected` and the rest.

Multi-step workflows work too. `?seed=form-capacity-blocked` fills the form; pressing
"Find my seats" then runs the real capacity gate against the mocked
`searches.capacityPreview` and blocks the submit with the ceiling message.

### How it works

`apps/mobile-web/src/lib/trpc.ts` composes the tRPC client from a link array. Inside
`__DEV__` it prepends `devTransportLink` (`apps/mobile-web/src/lib/devTransport.ts`),
which either terminates an operation with fixture data or passes it straight through when
no handler is installed. Handlers come from
`apps/mobile-web/src/fixtures/mockTransport.ts`. This follows the seam
`apps/mobile-web/src/lib/geocodeSeam.ts` already established for `resolvePlace`.

A handler returns one of three outcomes: `data`, `error` (whose `code` and extras land
where `apps/mobile-web/src/lib/errorEnvelope.ts` reads them, so `ADMISSION_REJECTED`
reaches the CTA), or `pending` — which never settles, and is how the loading states are
held open for as long as you want to look at them.

### Adding a scenario or a profile

Add an entry to `DEV_SCENARIOS` (`apps/mobile-web/src/fixtures/scenarios.ts`) or to
`API_PROFILES` plus its branch in `createApiHandler`
(`apps/mobile-web/src/fixtures/mockTransport.ts`). Build response data with the fixture
factories in `apps/mobile-web/src/fixtures/contracts.ts` (result contracts) and
`apps/mobile-web/src/fixtures/apiFixtures.ts` (request/response contracts) rather than
hand-rolling object literals.

Those factories return values that parse against the real schemas in
`packages/core/src/result-contracts.ts` — no `as unknown as` casts.
`contracts.test.ts`, `apiFixtures.test.ts`, and `devTransport.test.ts` (all under
`apps/mobile-web/src`) enforce that: every builder, every scenario, and every profile's
output for every procedure it answers is parsed by the schema the server would satisfy.
Each scenario's status/answer pair also goes through `RevealPayloadSchema`, which runs the
same consistency refinement `SearchResultSchema` does, so an impossible combination fails
the suite rather than rendering.

Fixture values carry no product meaning — `seatScores` is uniformly zero and the mocked
session's `limits` are zero, because nothing reads them and plausible-looking numbers
would be inventing policy nobody has written down.

### What this does not cover

The search lifecycle itself — the `searches.onProgress` SSE stream and `searches.get` — is
deliberately not mocked. Seeding a terminal result straight into the store is simpler than
simulating a stream, and the `result-*`, `partial`, and `halted` scenarios already cover
what those surfaces render. Use the Compose stack below when you need the real lifecycle,
real durability transactions, or real parsers.

## Setup (once)

```bash
cp .env.dev.example .env.dev
cp .env.dev.secrets.example .env.dev.secrets
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets up -d
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets run --rm seed
```

The two dev templates have working non-production values for everything except
`CHROME_EXECUTABLE_PATH` (only needed for `full` mode — see below). Put real TMDB or Mapbox
tokens only in `.env.dev.secrets`. `migrate` runs automatically on every `up` and must
complete successfully before any DB-using service starts (ADR 0005 §G); you do not
need to run it manually. `seed` is a one-shot service that never runs as part of a
bare `up`, by design — always invoke it explicitly. `seed` is not
fully idempotent: it mints fresh `run`/`observation` rows every time, but its `run_key` rows
for the SCHEDULE_RESOLUTION/SHOWTIME_FETCH seeds use deterministic ids matching production's
`stageSearchCreation` (`k_sched_...`/`k_fetch_...`), so a later `searches.create` converges
via `RUN_KEY_UPSERT`.

If you have a pre-existing dev database that was created before the ledger
(`schema_migration` table, ADR 0005 §G) existed, run the one-time baseline after
`up` and before `seed`:

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets run --rm migrate --baseline
```

This records every migration as already applied without re-running DDL, so a
fresh `migrate` does not replay `001`..`018` against an existing schema. Fresh
volumes (`down -v` then `up -d`) never need this — the automatic `migrate`
creates and populates the ledger from scratch.

If the data looks stale (showtimes dated in the past because the environment has sat idle
for a day), just re-run `seed` on its own — no volume wipe needed. Because those `run_key`
ids are deterministic and upserted idempotently, re-running

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets run --rm seed
```

safely redistributes every seeded theatre's showtimes across the 30-day window starting at
the seed date (today on Fri/Sat/Sun, or the next Friday on Mon–Thu) — deterministically: the
per-performance date assignment uses a fixed-seed PRNG
(`packages/durability/scripts/seed-schedule-dates.ts`), so every run lands each performance
on the exact same date. It leaves behind benign accumulated `run`/`observation`/`search`
history rows — audit bloat, not a correctness problem. **Reserve a full reset for a clean slate**
(schema/migration changes, or wanting to clear that history entirely): `docker compose -f
docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets down -v`, then repeat
the setup commands above (`up -d` and `run --rm seed` — `migrate` runs automatically).

## Mode 1 — api-only (default)

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets up -d api web
```

Brings up `postgres` + `valkey` + `api` + `web` (the Expo web dev server for
`apps/mobile-web`, published at `http://localhost:8081` — `WEB_PORT` in `.env.dev`).
`theatres.search`/`theatres.movies` are fully real — cache-only reads (S20.8/S21.8) over
the rows `seed` just wrote with real durability transactions and real parsers. Query any date
in the window printed by `seed` (seeded showtimes are randomly spread across the full 30-day
window starting at the seed date — today on Fri/Sat/Sun, the next Friday on Mon–Thu). Real
data spans the whole window, but a specific theatre/date pair is not guaranteed non-empty —
low-volume theatres (e.g. Kabuki) can land on zero showtimes for the default "This weekend ·
Evenings" window by chance, so pick a date from `seed`'s printed per-theatre date list to be
sure. These theatres have seeded schedules:

- `amc:theatre:2325` (AMC Metreon 16, san-francisco) — 66 showtimes spread across the window
- `amc:theatre:4145` (AMC Kabuki 8, san-francisco) — 27 showtimes spread across the window
- `amc:theatre:416` (AMC Southlake 24, atlanta) — 104 showtimes spread across the window

15 theatres total are catalogued (the full Atlanta + San Francisco market goldens), but only
the three above have seeded schedules.

**`showtimes.recheck` legitimately times out in this mode** (`UNAVAILABLE`/`TIMEOUT` after
`RECHECK_DEADLINE_MS`) — `RECHECK` has no cache path by design (S22.3): it always stages a
fresh `RUN` and awaits it, and nothing processes `RUN` jobs here. **Expected, not a bug.**

## Mode 2 — full (real RUN pipeline, fixture network by default)

```bash
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets build fetch-worker
docker run --rm seatfirst-dev-fetch-worker find /ms-playwright -iname 'chrome' -type f
# pin the printed path as CHROME_EXECUTABLE_PATH in .env.dev, then:
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets --profile full up -d
```

Adds `relay` + `sweeper` + `fetch-worker` to mode 1. The fetch-worker is the real image and
real Chrome. By default (`AMC_LIVE_FETCH` unset/false in `.env.dev`) its network hop is fake
(`infra/docker/fetch-worker/dev-entrypoint.mjs`'s `fetchHop`, bind-mounted alongside
`dev/fixtures/amc/` — never baked into the image): it serves only fixture schedule and seat-page
document routes, and refuses everything else. A live navigation past this dev seam is therefore
structurally impossible in this default configuration. Setting `AMC_LIVE_FETCH=true` deliberately
switches to the real network instead — see "Real AMC fetches" below; it does not change anything
described in this section unless you set it.

### Fixture outcome scenarios

ADR 0040 adds deterministic seat-fetch scenarios for fixture-only full mode. Set these values in
`.env.dev`, then recreate only the worker:

```bash
DEV_FIXTURE_SCENARIO=mixed-partial
DEV_FIXTURE_SEED=seatfirst-dev-fixture-v1
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets --profile full up -d --force-recreate fetch-worker
```

- `full` (default) serves every seeded-schedule showtime from one of the three synthetic seat-map
  profiles.
- `mixed-partial` deterministically fails one of four per-showtime hash buckets (75% successful,
  25% failed). A search containing both outcome types exercises the real terminal `PARTIAL` path.
- `all-error` fails every seat-page fetch, without changing provider control state or using the
  live network.

The seed and numeric showtime ID determine both the synthetic seat-map profile and outcome. The
same scenario and seed therefore reproduce the same rows and failures regardless of request order.
Record both values with any dev-stack finding.

`showtimes.recheck` resolves through the real worker path for showtimes in the seeded schedules.
The three original profile examples are:

```text
showtimeId: amc:showtime:145927006   theatreId: amc:theatre:2325   Spider-Man: Brand New Day
showtimeId: amc:showtime:146024502   theatreId: amc:theatre:4145   The Invite
showtimeId: amc:showtime:146089621   theatreId: amc:theatre:416    Toy Story 5
```

Check the fetch-worker logs to confirm zero requests reached any non-loopback host —
there is no code path that could (the dev `fetchHop` never touches the real network stack;
anything not matching its two fixture routes throws instead of falling through).

### Why `CHROME_EXECUTABLE_PATH` has to be discovered, not guessed

The path is inside the pinned Chromium build `playwright-core` downloads at image build
time (`Dockerfile.fetch-worker`) — its exact revision (and therefore its exact on-disk path)
tracks whatever `playwright-core` version `packages/browser-runtime/package.json` pins, so
it isn't a stable literal to hardcode here. Run the `find` command above once per rebuilt
image and re-pin if you ever bump `playwright-core`.

## Optional — real TMDB metadata (opt-in by presence of `TMDB_API_KEY`)

The `tmdb` service talks to **api.themoviedb.org, never AMC**. It runs the production TMDB
metadata worker image (ADR 0019) against the local stack so movie metadata resolves for real
instead of from fixtures. It is part of the default service set — no `--profile` flag — and
gates itself purely on whether you supplied a key:

```bash
# put your own key in .env.dev.secrets — the one value left genuinely blank:
# TMDB_API_KEY=<your v4 Bearer token> from https://www.themoviedb.org/settings/api
docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file .env.dev.secrets up -d tmdb
```

Leave `TMDB_API_KEY` blank and the `tmdb` container starts, logs a one-line skip message,
and exits cleanly — no crash loop, no separate profile to remember. The worker enforces its
own rate limit internally (~30 req/s token bucket, hard-coded in
`apps/server/src/tmdb/token-bucket.ts`) — there is no traffic/rate env to configure.

The service keeps the internal `default` network for Postgres, Valkey, and OTLP. A dedicated
Compose-managed `tmdb-egress` bridge provides its outbound TMDB path. The bridge has no host
ports, and the AMC fetch worker does not join it.

## Real AMC fetches (`AMC_LIVE_FETCH=true`)

**Decided by Josh Wu — ADR 0034, config-flag path, 2026-08-23: real AMC traffic from a local
dev machine is authorized, the risk of gating it with a plain configuration flag explicitly
accepted.** On 2026-09-17 Josh Wu extended that risk-acceptance to any public self-hoster
who chooses to opt in. Read `docs/adr/0034-local-dev-real-amc-fetch-session-mode.md` before
using this (that ADR itself is not shipped in this public repo — the warning below gives
you the gist).

**If you are self-hosting this repo, read this before you touch the flag.** Setting
`AMC_LIVE_FETCH=true` sends real requests to AMC's live site from your machine, and those
requests are not attributed to SeatFirst-the-project — they are yours. Turning this on is
your own decision and your own risk: Josh Wu's ADR 0034 decision extends his own personal
risk-acceptance to third parties who choose to opt in, but it is not a review or
endorsement of your individual choice to do so. And before you ever set the flag to `true`,
you must change `AMC_USER_AGENT` in `.env.dev` from the shipped placeholder
(`SeatFirst-Dev/1.0 (local development/testing use; mailto:dev@seatfirst.example)`) to your
own real, honest contact information — the shipped placeholder is not a valid real-world
identification string.

Default is unchanged and safe: `AMC_LIVE_FETCH` unset/`false` in `.env.dev` keeps mode 2
entirely fixture-served, as described above. Setting `AMC_LIVE_FETCH=true` in `.env.dev`
before bringing up `--profile full` instead runs the SAME real `entrypoint.mjs` production's
fetch-worker image already contains — real Chrome, real navigation, real requests to
`www.amctheatres.com` — for **both** the RUN provider-fetch actor (seat/schedule fetches)
**and** the S26/ADR-0022 catalogue-crawl loop (theatre-directory crawl); they share one
entrypoint, so the flag affects both, not just the one you were probably thinking of. It
reuses production's request-discipline code unmodified — one-in-flight, jitter, backoff,
halt-on-challenge, audit logging (ADR 0002 §2.3/§2.8) — this flag only selects which
entrypoint runs, it does not relax anything that code enforces.

**Before setting this to `true`, if you're running more than one instance of this stack on
the same machine:**

- Give each instance its own Compose project name and check for shared host ports, volumes,
  networks, and bind mounts — see `docker-compose.dev.yml`'s header comment for what was
  audited between the dev and production shapes.
- **Egress identity is not guaranteed distinct.** If another stack on the same host routes
  through host-wide egress — for example, this project's own private production stack, whose
  `tailscale` service uses `network_mode: host` exit-node routing — this stack's live traffic
  may ride the same route, not a separate one, no matter what `EGRESS_IDENTITY_LABEL` says.
  Verify your actual egress IP before trusting the
  label (e.g. `docker compose -f docker-compose.dev.yml --env-file .env.dev --env-file
.env.dev.secrets --profile full run --rm fetch-worker
sh -c "wget -qO- https://ifconfig.me"` and compare against what you expect).
- **Never run `AMC_LIVE_FETCH=true` at the same time as another live fetch pass on the same
  machine** (another instance of this stack, or this project's own private production
  stack). The instances have entirely separate Postgres/Valkey, so there is no shared
  one-in-flight semaphore between them — this tooling cannot enforce that exclusion for
  you, it can only warn (the fetch-worker logs a loud reminder on startup when the flag
  is on). Treat it as an operator discipline, not a guarantee.
- You must update `AMC_USER_AGENT` in `.env.dev` from the shipped placeholder to your own
  real, honest contact information before ever setting the flag to `true` (see the warning
  above — the shipped placeholder is not a valid real-world identification string), and
  update `EGRESS_IDENTITY_LABEL` to a value you're comfortable being a real, attributable
  identifier sent with real requests (the shipped defaults already satisfy
  `packages/providers/src/amc/identity.ts`'s validator — product name plus contact — but
  they must still say something true about you before going live).

## Re-keying another seat fixture (optional)

Three source seat fixtures (see `dev/fixtures/amc/README.md`'s `seats/` section for the
inventory), re-keyed to real seeded showtime ids, prove the chain end-to-end. To add another,
pick a real captured seat fixture from
`packages/providers/fixtures/redacted/seats-*.golden.json` with the availability profile you
want, and a target showtime from one of `dev/fixtures/amc/schedule/*.json`'s parsed
performances, then:

```bash
python3 -c "
import re
OLD, NEW = '<source numeric showtime id>', '<target numeric showtime id>'
raw = open('packages/providers/fixtures/redacted/seats-<OLD>.json').read()
assert len(re.findall(r'(?<!\d)' + OLD + r'(?!\d)', raw)) > 0
open('dev/fixtures/amc/seats/seats-<NEW>.json', 'w').write(
    re.sub(r'(?<!\d)' + OLD + r'(?!\d)', NEW, raw)
)
"
```

Then add an entry to `packages/durability/scripts/seed-dev-fixtures.ts`'s `SEAT_FIXTURES`
list so it actually gets seeded.
No change is needed in `infra/docker/fetch-worker/dev-entrypoint.mjs` for seats — its lookup
is by numeric id parsed straight from the intercepted URL, so any `seats-<id>.json` dropped
into `dev/fixtures/amc/seats/` is served automatically once seeded.

## What this does and doesn't authorize

`dev/fixtures/amc/` is hand-built synthetic data (see that directory's README) — never
treated as a captured payload, never read by `pnpm test`/CI. By default this whole stack
makes zero live AMC requests. `AMC_LIVE_FETCH=true` is the one deliberate exception,
decided by Josh Wu (ADR 0034) — it does not loosen ADR 0002's rules on what that traffic may
do once it's live (routes, rate caps, credential/token handling, kill-switch, audit trail
all still apply, enforced by the same production code); it only decides that a plain
config-flag gate is an acceptable way to reach that traffic from a local machine. TMDB is
unaffected either way — it was never governed by ADR 0002's AMC-specific rules.
