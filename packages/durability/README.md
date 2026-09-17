# @seatfirst/durability

Executable verification of **ADR 0001 — durability / search lifecycle state machine**.
Plan: [`docs/durability-harness-plan.md`](../../docs/durability-harness-plan.md).

The premise is that the ADR stops being the source of SQL truth:

- **`migrations/`** is the schema. It loads into an empty Postgres 16 or the suite fails.
- **`src/boundaries.ts`** is the statement at each crash boundary (B1–B10, B5F, plus the
  sweeper duties), each a named export the ADR cites by symbol.
- **`src/invariants.ts`** is the set of claims that must hold after any scenario, written
  as queries that return their own counterexamples.
- **`src/lifecycle.ts`** combines B8's persisted status/cause with answer-assembler
  evidence and fails closed when a terminal tuple has no ADR 0003 matrix row.

When the ADR and this package disagree, this package is right and the ADR is amended.

## Running it

```bash
pnpm test                # tiers 0–3, stopping at the first tier that fails
pnpm test:extended       # tiers 4–6 on the main/nightly path
pnpm test:all            # tiers 0–6 in order
pnpm test:tier0          # a single tier
pnpm test:tier5          # deterministic races only
pnpm test:tier6          # randomized invariants + semantic load profile
```

Needs a Docker daemon: the suite starts `postgres:16-alpine` via testcontainers, applies
the migrations once into a `durability_base` template, and clones it per test
(`CREATE DATABASE … TEMPLATE`), so isolation costs milliseconds. To run against a server
you already have instead, set `DURABILITY_PG_URL` to a superuser connection string — the
harness only needs to be able to `CREATE DATABASE`. The extended command starts
`redis:7-alpine` for tiers 4–5 (tier 6 itself uses Postgres only); set
`DURABILITY_REDIS_URL` to use an existing **disposable** Redis server instead. Because
the loss tests erase the entire server with `FLUSHALL`, an override is rejected unless
`DURABILITY_REDIS_ALLOW_FLUSHALL=1` is also set. Never point it at shared or persistent data.

CI runs tiers 0–3 on every PR in a dedicated `durability` job. Tiers 4–6 run on `main`
and nightly; the root `pnpm test` deliberately excludes this package so the rest of the
workspace stays Docker-free.

## Tiers

| Tier | File                      | Asserts                                                                                                                       |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0    | `tier0.schema.test.ts`    | migrations apply; FKs validated; every partitioned table has partitions; the first snapshot insert lands in a month partition |
| 1    | `tier1.executes.test.ts`  | every boundary statement `PREPARE`s against the live schema and takes exactly the parameters it documents                     |
| 2    | `tier2.effects.test.ts`   | each boundary moves the row counts it claims — the tier that catches statements which parse, commit, and touch nothing        |
| 3    | `tier3.lifecycle.test.ts` | ADR 0003 A1–A14 are reachable; B8 derives the stated status/cause and exactly one answer shape                                |
| 4    | `tier4.crash.test.ts`     | real backend termination at transaction barriers; Redis semaphore/session/projection crash windows                            |
| 5    | `tier5.race.test.ts`      | advisory-lock interleavings for creation, aggregation, fan-in, admission-headroom, and stale-projector races                  |
| 6    | `tier6.invariant.test.ts` | seeded conservation/reachability after every committed transition and gate 11's 10×35 semantic load profile                   |

Tests are named `tier<n>.*` so the sequencer's order is the tier order, run serially with
`--bail=1`: a broken migration fails in seconds rather than after a suite of timeouts.

Two rules keep the tiers honest:

- **Time is data.** Deadlines, leases and cooldowns expire by `UPDATE`, never by sleeping.
- **Fixtures are built from the boundary statements**, not from hand-written SQL. If a
  scenario needs a statement the ADR does not have, that is a finding about the ADR.

Every test in tiers 2+ ends with the full invariant sweep, so an effect assertion that
passes while conservation is broken is not a pass.

Tier 6 always runs fixed regression seeds. To append and replay another uint32 seed:

```bash
DURABILITY_RANDOM_SEED=123456 pnpm test:tier6
```

A randomized failure includes the seed, generated plan, and exact replay command. The load
profile prints one JSON object with naive jobs, runs, applications, completed jobs, satisfied
subscriptions, accepted events, coalescing ratio, maximum fan-in, and elapsed fan-in time.
The elapsed value is diagnostic only: there is no asserted performance threshold. This
synthetic profile does not settle production admission policy, rejection/queue UX, or close
all of architecture gate 11.

Tier 5 additionally requires the harness to observe a backend in `wait_event_type =
'Lock'` before releasing the winner. A race that merely starts two promises is not counted
as deterministic coverage.

## Deviations from ADR 0001

Recorded at the point of deviation in the SQL, and summarized in ADR 0001's review-round-6
note. The load-bearing ones: `performance` is defined here (§1 never declared the table
B5(c) and B6 both write); partitions are generated relative to `now()` rather than frozen
to 2026-08; B8 releases schedule slots by counting `run_subscription.admission_counted`
rather than the reservation's single boolean; and B5F's capacity release is fetch-only.
