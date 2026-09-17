# Contributing

Primary audience: AI coding agents working in this repo. `AGENTS.md` loads automatically
every session; this file is the deep reference, read on demand. Read this file in full
before you touch `packages/durability`, write a migration, or add a test.

This repo is **scaffolding plus real, tested backend packages**. `packages/durability`
(~2,285 source lines across 7 files, 7 test tiers) is the deepest code and remains the
quality bar everything else is measured against. `packages/core`, `packages/providers`, and
`packages/config` each carry real, tested code too — see `docs/backlog.md` for what each
task landed. Everything in `apps/*` and `infra/` is still a placeholder `export {}` waiting
on a gate.

---

## 1. Gates and ADRs come first

See `AGENTS.md` for the core rule: confirm the gate is closed and an approved ADR
authorizes the work before you implement anything, and never invent a decision nobody has
written down. That rule applies here without restatement.

Current ADR status: `docs/adr/README.md`. Read the status line inside the ADR file itself,
not any table that summarizes it — tables drift, the file does not.

### Traps that exist right now

These are live. Agents have walked into them.

- **Queue broker is not an implementation detail.** Architecture §8 deliberately carries
  five deployment shapes with different queue topologies (BullMQ/Redis, SQS, Vercel
  queues). Choosing one is **ADR 0004** (`docs/adr/README.md:11`, gates 5 and 8.7). Writing
  code that imports a broker SDK decides that ADR by default. ADR 0001 already gives you the
  out: queues are delivery hints, Postgres is truth. Write against the outbox tables.
- **`TOO_MANY_SHOWTIMES` is a number you may not pick.** The ceiling currently written down
  is 200 (`seatfirst-query-design.md:383`), and ADR 0003 treats it as a value under
  active pressure (`docs/adr/0003-searchspec-result-contracts.md:276`). Any change to it, or
  any new limit like it, is **gate 14** — numeric acceptance criteria, undecided.
- **Rate limiting and client-IP keying are gate 13.** Trusted-proxy chain and IP extraction
  rules are explicitly unspecified and explicitly spoofable-if-unspecified
  (`seatfirst-architecture.md:700`). Do not implement a limiter that keys on an IP you
  derived yourself.
- **The `AREA` theatre selector must stay rejected.** `TheatreSelector` is modeled as a union
  from day one so the shape is additive later, but the validator rejects `AREA` with
  `SELECTOR_UNSUPPORTED` in v1 (`seatfirst-architecture.md:676`,
  `seatfirst-query-design.md:387`). "Implementing" it is a v1.5 feature, not a gap.
- **Internal zero-subscriber cancellation ≠ user-facing cancel.** A run with no remaining
  live subscribers is cancelled internally (`seatfirst-architecture.md:223`, ADR 0001 T17).
  That is not `searches.cancel`, which is **gate 18** — **DECIDED (ADR 0013):** a genuine
  user-facing cancellation action, distinct from the internal zero-subscriber cleanup fallback.
  Do not present one as the other.
- **No live upstream traffic.** See §4.

---

## 2. Durability-package conventions — the house standard

Everything below is how `packages/durability` already works. Follow it in that package, and
follow its spirit anywhere else that touches persisted state.

### Named boundary statements

Every state transition is a **named, exported, single SQL statement** in
`packages/durability/src/boundaries.ts` (64 exports today, registered into `ALL_STATEMENTS`
by `define()`). The `Statement` interface (`boundaries.ts:23`) carries `boundary`, `name`,
`zeroRowsMeans`, `params`, `text`. Three rules, from the module header
(`boundaries.ts:1-20`):

1. **One statement per export.** `PREPARE` accepts exactly one, and tier 1 prepares every
   export. Multi-statement boundaries (B1, B5, B8, B9, B10) are split into named parts that
   carry the same boundary label.
2. **Every parameter is cast** — `$1::text`, not `$1`. Partly for inference, mostly so the
   intended type is stated rather than guessed by a reader.
3. **Every statement returns something.** The whole contract is "0 rows means the caller
   lost and must abort." A statement with no `RETURNING` cannot be checked, and `rowCount`
   on a bare `UPDATE` inside a CTE chain is not the number the caller cares about.

`zeroRowsMeans` is not decoration — `mustWin()` prints it when a fence loses, so a failing
test says what losing meant instead of `expected 1 to be 0`.

**Never write raw SQL at a call site or in a test to move state.** The scenario fixtures say
it plainly (`test/support/fixtures.ts:6-10`): "If a fixture needs a statement the ADR does
not have, that is a finding about the ADR, not a licence to write a one-off INSERT here."

This rule has been violated. The outbox `PENDING → PUBLISHED` transition has **no** exported
boundary statement — `boundaries.ts` exports `OUTBOX_CREATE_JOB`, `OUTBOX_CREATE_RUN`,
`SWEEP_OVERDUE_OUTBOX`, and `B6_VOID_ORPHANED_OUTBOX`, and nothing else touches
`outbox.state`. So two tests simulate the publish with a raw `UPDATE outbox SET state =
'PUBLISHED'` (`test/tier2.effects.test.ts:610`, `test/tier4.crash.test.ts:323`). The fix, if
you need that transition, is to add the named statement and let tier 1 and tier 2 see it —
not to copy the raw `UPDATE` a third time.

Exceptions that are legitimately not boundaries, and where they live: seed data
(`seedProvider`, `fixtures.ts:23`), test scaffolding that simulates a precondition rather
than performing a transition (`UPDATE provider_run SET attempt = 5`, `fixtures.ts:240`, with
a comment saying exactly that), and time manipulation (`test/support/clock.ts`). If you write
raw SQL, it must fall in one of those buckets and say so in a comment.

### Composed transactions

**Multi-statement sequences whose ORDER is load-bearing are composed and exported from
`packages/durability/src/transactions.ts`.** Callers do not assemble them; test fixtures do
not re-sequence them.

Why, concretely: ADR 0001 describes B8 as "one transaction." B8 is **seven** exports
(`B8_TERMINALIZE`, `B8_RESULT_VERSION`, `B8_CANCEL_JOBS`, `B8_EXPIRE_SUBSCRIPTIONS`,
`B8_RELEASE_ADMISSION`, `B8_CLEAR_SCHEDULE_SLOTS`, `B8_MARK_RESERVATION_RELEASED`,
`B8_TERMINAL_EVENT`, `B8_CANCEL_ORPHANED_RUNS`) whose ordering carries meaning —
release-then-clear-slots, expire-subs-then-cancel-orphaned-runs. Before
`transactions.ts:1-15` existed, the only place that order was written down was the test
fixtures: "tribal knowledge wearing a test's clothes." Nothing in `src/` could be cited as
the composition, and nothing outside the test suite could reuse it. `fixtures.ts:211`,
`:214`, `:258`, `:261` are now thin re-exports of the `src/` composition.

`cancelOrphanedWorkOnDenial` (`transactions.ts:406`) documents its own ordering rationale in
the same style. Match it: when order matters, the comment says _what breaks_ if you swap two
lines.

Where a composed body needs to be crash-testable, export the staged form without
`BEGIN`/`COMMIT` (`stageFetchAcceptance`, `stageTerminalization`) alongside the wrapped one.
That is how tier 4 kills a backend after every effect has executed and before any is durable.

### Invariants

`packages/durability/src/invariants.ts` holds 14 invariants, each a `SELECT` that **returns
its own counterexamples** — a failure names the offending search/key/run instead of
reporting `false`. `useDatabase()` runs the full sweep in `afterEach`
(`test/support/pg.ts:134-160`): "an effect assertion that passes while conservation is
broken is not a pass." New persisted state that can leak, double-release, or strand children
needs a new invariant, not just a new assertion.

---

## 3. Testing standards

### The tier model

Tiers are ordered by cost; a broken migration must fail in seconds, not after a suite of
timeouts. Files are named `tier<n>.*` so alphabetical order is tier order, they run serially
(`vitest.config.ts`: `fileParallelism: false`), and `--bail=1` stops at the first failure.

| Tier | File                      | Asserts                                                                                                                                 |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `tier0.schema.test.ts`    | migrations apply to an empty DB; FKs, partitions, structural claims                                                                     |
| 1    | `tier1.executes.test.ts`  | every `ALL_STATEMENTS` entry `PREPARE`s; param count matches `params`; every statement returns rows; every ADR boundary has a statement |
| 2    | `tier2.effects.test.ts`   | each boundary produces the row counts and committed effects it claims                                                                   |
| 3    | `tier3.lifecycle.test.ts` | ADR 0003's A-matrix: each row reachable through B1–B9 and deriving exactly one answer                                                   |
| 4    | `tier4.crash.test.ts`     | abort at each barrier via real `pg_terminate_backend`; assert state after reconnect                                                     |
| 5    | `tier5.race.test.ts`      | deterministic advisory-lock interleavings of known races                                                                                |
| 6    | `tier6.invariant.test.ts` | seeded conservation/reachability worlds + gate 11's semantic load profile                                                               |

**Tiers 0–3 run on every PR. Tiers 4–6 run on `main` and nightly** (`.github/workflows/ci.yml`,
jobs `durability` and `durability-extended`). Put a test in the lowest tier that can catch
the bug.

### Real state, not mocks

Tests run against real Postgres 16 and Redis 7 via testcontainers
(`test/support/global-setup.ts`). Migrations apply once into the `durability_base` template
and every test does `CREATE DATABASE … TEMPLATE`, so isolation costs milliseconds. Assert on
**committed rows read back**, never on a mock's call log. Crash injection is a real backend
kill (`test/support/pg.ts:47-71`), not a `ROLLBACK` wearing a costume. Races are advisory-lock
barriers, not sleeps. **Time is data**: expire a deadline by writing `deadline_at` into the
past (`test/support/clock.ts`), never by waiting. No test sleeps.

### Banned: vacuous tests

An assertion that would hold regardless of behavior is worse than no test — it converts an
open hole into a green check.

- **Do not mirror the implementation.** If the test recomputes the expectation with the same
  logic the code uses, it asserts that a function equals itself. Derive the expected value
  independently: from the ADR, from an accounting model (tier 6), or by hand.
- **Beware silently-unknown predicates.** The real case: a `PAUSED` test passed for months
  while never exercising its branch, because `not_before` was `NULL` and `NULL > now()` is
  SQL-unknown, so `state = 'PAUSED' AND not_before > now()` never blocked anything. The
  replacement sets a real future `not_before`, asserts dispatch and acceptance are both
  blocked, then expires it by writing the timestamp into the past and asserts both unblock
  (`test/tier2.effects.test.ts:175-214`, and see the comment at `:189` naming the old bug).
  When you assert "X is blocked," prove the same call succeeds once the blocking condition is
  removed. A negative assertion alone cannot distinguish "blocked" from "never ran."
- **Assert non-zero effects.** `RETURNING`-less statements and empty `RETURNING` clauses are
  how the worst bug in this project's history hid: an entire atomic fan-in silently processed
  zero rows (round 4 finding 1). Check the rows, not just the absence of an exception.
- **A new boundary statement ships with a test that fails without it.** Delete the statement
  mentally; if every test still passes, the test is not testing it.

---

## 4. Agent working rules

Baseline agent conduct — report observed output, cite sources, stay in scope, do not
commit/push without instruction, fix a defect a review finds — is assumed to already be part
of the operating agent's standing instructions and is not restated here. The rules below are
repo-specific: required because they are easy to get wrong specifically in this repo:

**Verify before asserting.** Re-read the file. Do not trust a summary, a directory listing,
a cached mental model, or your own earlier claim in this same session. Files change under
you — including from the user's own editor.

**No unauthorized outbound requests to upstream data sources.** `amctheatres.com` in
particular: ADR 0002 §2.1 (Terms of Use) and §2.2 (robots.txt) — the two items that gated
fixture capture — **resolved 2026-08-08** (`docs/adr/0002-legal-data-use.md` §2.4 "Condition
met", `docs/deferred-decisions.md`). That authorizes **only** the bounded, human-authorized
session in ADR 0002 §3.4 — normally human-supervised, with the single 2026-08-10 operation
explicitly delegated by decision owner Josh Wu to Codex — backlog task `P3` (`docs/backlog.md`):
capped at 150 logical top-level navigations, one in-flight, jittered backoff, and redacted before
commit; redirects remain separately audited. Nothing else is authorized. CI enforces
the non-P3 posture with `SEATFIRST_ENV: ci` (`.github/workflows/ci.yml:14-16`). The live ToS
page returns HTTP 403 to automated fetches — why a human read it directly instead.

One further, non-production exception is recorded in ADR 0002 §3.4: on 2026-08-11 Josh Wu
authorized exactly one direct Node `GET /movies` using the browser-style Chrome 136 `User-Agent`
used during preregistration plus an identifying SeatFinder/contact suffix, with manual redirects,
no cookies or clearance material, no challenge solving, no retry, and no payload persistence. It
does not authorize a fixture capture rerun, provider identity changes, or any additional AMC
request. That request was executed once on 2026-08-11 and returned HTTP 403 with Cloudflare
challenge markers. The exception is consumed.

A second diagnostic exception was explicitly authorized by Josh Wu on 2026-08-11: one direct
Node `GET /movies` using the same Chrome 136 browser-style `User-Agent` without the
SeatFinder/contact suffix, solely to isolate whether that suffix caused the first probe's 403. It
retains manual redirects, no cookies or clearance material, no challenge solving, no retry, and no
payload persistence, and it authorizes no follow-up request, capture rerun, or provider change.
The second request returned the same HTTP 403 and Cloudflare challenge classification as the
suffixed request. Its authorization is consumed, and the suffix is ruled out as the cause of this
block.

A third diagnostic exception was explicitly authorized by Josh Wu on 2026-08-11: one ordinary
browser page load of `/movies`, including normal subresources, followed by exactly one standalone
test request derived only from redacted, non-sensitive browser request metadata. Do not record or
replay cookies, authorization values, Cloudflare clearance tokens, response bodies, or other
session secrets. The standalone request remains manual-redirect, cookie-free, clearance-free,
challenge-free, retry-free, and non-persistent. It authorizes no subsequent request, capture
rerun, or provider change.
That browser load reached an ordinary page, while the standalone HTTP/2 request with a constructed
Chrome 136 navigation-header profile returned HTTP 403. Both parts are consumed. The redacted
comparison is `packages/providers/fixtures/BROWSER-REQUEST-COMPARISON.md`; it shows that ordinary
header parity is insufficient.

**Distinguish "I could not verify this" from "this is fine."** They are different findings
and only one of them is safe to act on. Say which one you have.

---

## 5. Mechanics

### Toolchain

Node 24 (`.nvmrc`), pnpm 11.5.2 (`corepack enable`), `engine-strict=true`. pnpm workspaces
(`apps/*`, `packages/*`, `infra`) + Turborepo. Vitest 4 everywhere. Zod 4, tRPC 11, Fastify 5
in `apps/server`; Expo 57 / React Native in `apps/mobile-web`; `pg` 8 in
`packages/durability`. Docker is required for the durability tests only.

### Commands (verified 2026-08-04)

From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck                # turbo run typecheck — strict tsc, whole workspace
pnpm lint                     # eslint . (type-aware)
pnpm lint:fix
pnpm lint:docs                # markdownlint-cli2 + scripts/check-doc-refs.mjs
pnpm test:scripts             # vitest, unit tests for scripts/*.mjs (the checker itself)
pnpm format                   # prettier --write .
pnpm format:check             # what CI runs
pnpm test                     # turbo run test --filter=!@seatfirst/durability
pnpm build                    # turbo run build, topologically ordered
pnpm test:durability          # tiers 0–3   (needs Docker)
pnpm test:durability:extended # tiers 4–6   (needs Docker; main/nightly in CI)
```

**`pnpm test` at the root deliberately excludes `@seatfirst/durability`** (see the
`--filter=!` in `package.json`). A green root `pnpm test` says nothing about the durability
harness. Run `pnpm test:durability` too.

Inside `packages/durability`:

```bash
pnpm --filter @seatfirst/durability test          # tiers 0–3, --bail=1
pnpm --filter @seatfirst/durability test:tier0    # …:tier1 … :tier6, one tier
pnpm --filter @seatfirst/durability test:extended # tiers 4–6, DURABILITY_REDIS_REQUIRED=1
pnpm --filter @seatfirst/durability test:all      # every tier
pnpm --filter @seatfirst/durability typecheck
pnpm --filter @seatfirst/durability build         # tsc -p tsconfig.build.json
```

Useful env vars: `DURABILITY_PG_URL` (skip testcontainers, use an existing superuser URL),
`DURABILITY_REDIS_REQUIRED=1` (fail instead of skip when Redis is absent),
`DURABILITY_RANDOM_SEED=<uint32>` (append a replay seed to tier 6's fixed regression seeds;
failures print the exact replay command, `test/support/random.ts:96-115`).

There is no `dev`, `start`, or `migrate` script at the root, and no `test:watch`. Do not
document or invoke one.

### Lint/format state — currently green, keep it that way

This branch was briefly red (17 `eslint` errors in `packages/durability/src/transactions.ts`
from `no-explicit-any`/`no-unsafe-*`, plus 4 `format:check` failures). Both are now fixed.
Observed on branch `durability-harness-tiers-0-2`, 2026-08-04:

- `pnpm typecheck` — passes (8/8 tasks).
- `pnpm test` — passes (6/6). `packages/core` now carries real tests in that run (119 tests,
  3 files); every other non-durability package is still `--passWithNoTests`.
- `pnpm --filter @seatfirst/durability test:tier0` — passes, 10 tests, 5.48 s.
- `pnpm test:durability` — passes, 128 tests across tiers 0–3.
- `pnpm test:durability:extended` — passes, 27 tests across tiers 4–6.
- `pnpm lint` — passes, 0 errors.
- `pnpm format:check` — passes, "All matched files use Prettier code style!"

CI runs `format:check`, `lint`, `typecheck`, `test`, `build`, then the durability job, and
all of it is green right now. That is a state to preserve, not a fact to stop verifying:
run `pnpm lint` and `pnpm format:check` yourself before you report on them, don't cite this
section as current evidence, and if your change introduces a new failure, fix it in the same
change rather than leaving the repo red for the next agent.

### Workspace layout — what goes where

```text
apps/mobile-web        Expo RN app (iOS/Android/web). Gated on gates 7, 22 (gate 2 closed).
apps/server            Fastify + tRPC API and workers, one image two commands. Gates 2, 8, 16, 17 closed; still gated on the rest of packet (a)/(b) (gates 4, 22).
packages/core          SearchSpec, enums, bitmap engine, scoring, answer contracts, Zod schemas. Pure, no I/O.
packages/providers     VenueProvider contract, error taxonomy, fixture-replay harness. AMC adapter itself is still gated on gates 1 and 7.
packages/durability    Migrations, boundary statements, transactions, invariants, lifecycle, Redis fences, tiers 0–6.
packages/config        Shared eslint + tsconfig base, plus OTel SDK wiring (O1).
infra/                 CDK stacks. Gated on gate 5 / ADR 0004.
```

Type flow is inference-only, no codegen: `core` defines contracts, `server` exports its
`AppRouter` type, `mobile-web` compiles against it. Each stub carries a placeholder
`src/index.ts` explaining which gate blocks it; delete the placeholder when real code lands,
and keep the gate citation in the first real file.

### TypeScript and Zod

`packages/config/tsconfig.base.json` is the single base: ES2024, `NodeNext`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`,
`useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`. CI fails on any type
error anywhere. Do not loosen these per-package.

- ESM only (`"type": "module"`); relative imports carry the `.js` extension
  (`import * as B from "./boundaries.js"`), because `NodeNext` requires it.
- `verbatimModuleSyntax` means type-only imports need `import type`.
- `readonly` on interface fields and `readonly T[]` on parameters is the prevailing style —
  see `src/transactions.ts` and `src/lifecycle.ts`.
- Model exhaustiveness in the type system where the domain is closed: `RankedAnswer` is a
  discriminated union and `HedgedAlternatives` is a tuple of exactly 2 or 3
  (`src/lifecycle.ts:51-70`). Values that arrive from the database are typed as `string` at
  the boundary "so an unrecognized persisted cause fails closed at runtime"
  (`src/lifecycle.ts:81`) — then switched over with a `default:` that throws.
- Zod 4 lives in `packages/core` and `packages/providers`. The canonical `SearchSpec` schema
  (gate 2) is written — `packages/core/src/search-spec.ts` — along with `specHash`
  canonicalization and the discriminated result-contract unions in
  `packages/core/src/result-contracts.ts` (ADR 0003). Import from `packages/core`; do not
  draft a competing schema in another package.
- No `any` across an adapter boundary (architecture §12). The durability _tests_ are the one
  scoped exemption, and `eslint.config.js:5-12` explains why in full: naming a type for every
  SQL projection would restate the `RETURNING` clause in a second place that can drift.

### Prettier

`printWidth: 100`, double quotes, semicolons, `trailingComma: "all"`, `arrowParens:
"always"`. Run `pnpm format` before you finish; `format:check` is the first CI step.

### Migrations

`packages/durability/migrations/NNN_name.sql`, applied in the order listed in
`MIGRATIONS` (`src/migrate.ts:64`). Tier 0 asserts the on-disk `.sql` set equals that list —
"a file nobody applies proves nothing" (`test/tier0.schema.test.ts:55`). Each file runs as one
multi-statement command inside `pg`'s implicit transaction, so a file that fails halfway
leaves nothing behind; keep it that way (no `COMMIT` mid-file).

`001_schema.sql` is **authoritative over ADR prose**: "Where this file and the ADR disagree,
this file is right and the ADR is amended" (`migrations/001_schema.sql:1-6`). Every deliberate
deviation from the ADR is enumerated in that header — add to that list when you deviate, with
the reason. Conventions in force: dependency order (not reading order), text ULIDs,
`timestamptz` throughout, enum-like columns as `text` + `CHECK`. Partitions are **generated
relative to `now()`** by `ensure_snapshot_partitions()`, never frozen to a literal month —
a frozen partition is the same bug with a longer fuse (`002_partitions.sql:1-7`).

Migrations are **ledgered and applied once** (ADR 0005 §G,
`docs/adr/0005-security-privacy-operations.md:548-637`). The runner owns a
`schema_migration (name, applied_at)` table it creates via `CREATE TABLE IF NOT EXISTS`
— never as a numbered migration — and records names only (no checksum). In practice:
adding a file to `MIGRATIONS` (`packages/durability/src/migrate.ts:64`) is all that is
needed; the runner applies only pending files and the init `migrate` service (Compose
`service_completed_successfully`, `docker-compose.prod.yml:274-285`,
`docker-compose.dev.yml:109-121`) ensures that happens before any long-lived process
starts. **Never edit a landed file's effect on an already-migrated database** — the
ledger will not re-run it. A pre-existing database that predates the ledger is
**baselined** once (`baselineMigrations` / `baseline(pool)` in
`packages/durability/src/migrate.ts` and `src/pool.ts`) — recorded as applied without
running — never replayed, because 16 of the 18 existing files fail on a second
application (bare `CREATE TABLE` / `ALTER TABLE ... ADD COLUMN`; only
`008_cancelled_status.sql` and `013_recurring_window_search_admission.sql` are
re-runnable).

Every long-lived process verifies at boot that the ledger contains every migration its
binary expects and refuses to start otherwise (`verifySchemaVersion` in
`packages/durability/src/migrate.ts`). Ledger rows the binary does not know about are
allowed — that is the rollback case.

**Expand then contract.** `scripts/ops/rollback-prod.sh:6-7` restores the previous image
tag but never reverses a migration, and no down-migration mechanism exists. Therefore
every migration must remain compatible with the immediately previous image: add nullable
columns and defaults in release N, drop or tighten no earlier than N+1, never both in one
release. `013_recurring_window_search_admission.sql:112`
(`ALTER TABLE run_subscription DROP COLUMN IF EXISTS admission_counted`) is the
grandfathered counterexample that would have made a rollback of that release
unrecoverable; `014`–`018` are purely additive and already conform.

**Role privileges are first-boot configuration, not migrations**
(`infra/config/postgres/14-app-role.sh`, ADR 0081 §9). The script runs only
while the image creates a new data directory, so `seatfirst_app`'s grants are
fixed at first initialization: a later privilege change needs a migration or an
ops script, never an edit to that file alone. The same holds for
`13-scheduler-roles.sh`. The durability test template replicates the blanket
DML default in `test/support/global-setup.ts`, so the boundary tests feel the
production shape.

**Every migration that creates a function owes an explicit privilege decision.**
`14-app-role.sh` revokes the `EXECUTE`-to-`PUBLIC` default durably (both the
immediate `REVOKE` and the default-privileges revoke — the latter with no `IN
SCHEMA` clause, which would revoke nothing), so a new function is callable by
nobody until its migration says who calls it. Name the calling role, grant
`EXECUTE` to that role only, and grant nothing to `seatfirst_app` unless the
application actually calls it — a function no role is granted is a valid
outcome and the safe default. Granting the runtime role `EXECUTE` by reflex
hands it the retention and maintenance routines `retention_worker` exists to
own, and on a `SECURITY DEFINER` function such a grant is a
privilege-escalation path through the role boundary.

### Fixtures

Two different things share the word:

- **Synthetic scenario fixtures** — `packages/durability/test/support/fixtures.ts`. Composed
  out of boundary statements. Hand-built payloads, `jsonb`, `{ v: 1 }` specs. These are
  unrestricted and are how ADR 0001 and 0003 proceed schema-first without touching upstream.
- **Captured upstream fixtures** — `packages/providers/fixtures/`. **Empty by design.** No
  corpus exists and none may be captured until gate 1 clears. `.gitignore:29` blocks
  `packages/providers/fixtures/raw/` specifically so a captured payload cannot be committed
  by accident, with the reason in the two comment lines above it. When the gate clears:
  `raw/` stays ignored, `redacted/` holds cleared payloads CI replays, and each fixture pairs
  with a golden expected output (`packages/providers/fixtures/README.md`).

Do not "unblock" yourself by removing that `.gitignore` line, and do not synthesize a file
that looks like a captured payload.

### Commits and PRs

- Commit directly to `main`. Commit only when asked.
- Subject line: imperative, scoped, and it names what changed —
  `test(durability): add tier 6 invariant harness`, `Durability harness: add tier 3 lifecycle
matrix`. Both styles are in the history; match the neighbors.
- One concern per commit. A defect fix and a refactor are two commits.
- Before you propose a PR: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
pnpm test:durability` — and report each result as observed, including failures you did not
  cause (see the known-red list above).
- In the PR body, cite the gate or ADR that authorizes the change. Work that no gate or ADR
  authorizes does not get a PR; it gets a finding.
