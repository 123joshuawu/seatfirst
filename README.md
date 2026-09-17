# Seatfirst

Find the best available seats at a theatre, fast, and hand off to the provider's checkout.

Backend packages (`core`, `durability`, `providers`, `config`) have real, tested code today;
`apps/*` and `infra/` remain scaffolding-only placeholders. See [Status](#status).

## Disclaimer

Seatfirst is an independent, personal project. It is **not affiliated with,
endorsed by, or sponsored by AMC Theatres** (or any other exhibitor whose
public website it reads). All theatre, movie, showtime, and seat-availability
data shown by this software belongs to its respective owners.

Seatfirst performs only low-volume, courteous reads of publicly accessible
marketing pages — no credential use, no control-circumvention, and it backs off
whenever the upstream signals overload. It is built and shared for
**personal and educational, non-commercial use**. If you self-host it, you are
responsible for using it the same way: keep request volumes human-scale,
respect the upstream site's terms and traffic controls, and do not use it to
redistribute scraped data or to build a commercial service on top of someone
else's listings.

## Design documents

| Document                                                                     | What it covers                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`docs/seatfirst-brief.md`](docs/seatfirst-brief.md)                         | Product brief                                                                    |
| [`docs/seatfirst-spec.md`](docs/seatfirst-spec.md)                           | Product spec                                                                     |
| [`docs/seatfirst-query-design.md`](docs/seatfirst-query-design.md)           | Query path, bitmap engine, data model                                            |
| [`docs/seatfirst-architecture.md`](docs/seatfirst-architecture.md)           | Application + infrastructure architecture (authoritative for this repo's layout) |
| [`docs/amc-public-website-api-spec.md`](docs/amc-public-website-api-spec.md) | Upstream provider surface                                                        |
| [`docs/adr/`](docs/adr/README.md)                                            | Decision records — the docket that unblocks implementation                       |

## Layout

```text
apps/mobile-web     # Expo RN app (iOS/Android/web) — placeholder
apps/server         # Fastify + tRPC API and fetch workers — placeholder
packages/core       # SearchSpec, enums, bitmap engine, scoring, Zod schemas
packages/durability # Migrations, boundary statements, transactions, invariants, lifecycle
packages/providers  # VenueProvider contract + AMC adapter + fixtures
packages/config     # shared eslint / tsconfig / otel config
infra/              # CDK stacks — placeholder
docs/adr/           # architecture decision records
```

Per-package detail and gate status: `CONTRIBUTING.md` §5 "Workspace layout".

Type flow is inference-only, no codegen: `packages/core` defines the contracts, `apps/server`
exports its `AppRouter` type, `apps/mobile-web` compiles against it (architecture appendix A).

## Prerequisites

- Node 24 (`.nvmrc`; `nvm use`)
- pnpm 11 (`corepack enable`)

## Commands

```bash
pnpm install
pnpm typecheck     # strict tsc across the workspace; CI fails on any error anywhere
pnpm lint          # eslint, type-aware
pnpm lint:docs     # markdown style + link/citation check
pnpm test          # vitest — excludes packages/durability, see below
pnpm build         # turbo build, topologically ordered
pnpm format        # prettier
```

`pnpm test` at the root does **not** run `packages/durability`'s suite (it needs Docker). Run
`pnpm test:durability` too. Full command list, env vars, and per-tier commands: `AGENTS.md` and
`CONTRIBUTING.md` §5.

## Status

Gate/ADR status (source of truth): `docs/adr/README.md`. Current task status and what's next:
`docs/backlog.md`. Per-task requirements: `docs/tasks/`.

**Live upstream traffic is restricted.** Ordinary development, CI, and staging never make live
requests to the provider. The only exceptions are a bounded, human-authorized fixture-capture
session (ADR 0002 §3.4, task P3) and production traffic under ADR 0002 §2.8's counsel-authorized
browser-fingerprint impersonation constraints — six safeguards that must ship before any such
traffic runs. See `docs/gates.md` before writing anything that talks to an upstream provider.
