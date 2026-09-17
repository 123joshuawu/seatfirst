# Dev fixtures (`dev/fixtures/amc/`)

**Dev-only, hand-built synthetic data. Not a captured payload.** These files are a distinct
bucket from `packages/providers/fixtures/redacted/` (the real regression corpus governed by
P2/P3 and `check-fixture-hygiene.mjs`) — see CONTRIBUTING.md's Fixtures section, which already
carves out "synthetic scenario fixtures" as unrestricted. This directory is:

- never read by `pnpm test` or CI (only `packages/durability/scripts/seed-dev-fixtures.ts`
  reads it, and only when an operator runs it against a local dev Postgres),
- never subject to `packages/providers/scripts/check-fixture-hygiene.mjs` (that script only
  scans `packages/providers/fixtures/`),
- never to be treated as evidence that any of this data was actually observed on
  `amctheatres.com` at the timestamps it carries.

## `schedule/` — verbatim copies, no re-keying

Byte-for-byte copies of three real captured raw bodies from
`packages/providers/fixtures/redacted/schedule-amc-*.json` (the 2026-08-13 UTC capture
session, `packages/providers/fixtures/CAPTURE-LOG.md`), chosen to overlap the theatre catalogue
below and span two metros:

| file                                        | theatre                              | market        | showtimes |
| ------------------------------------------- | ------------------------------------ | ------------- | --------- |
| `schedule-amc-metreon-16-2026-08-13.json`   | AMC Metreon 16 (`amc:theatre:2325`)  | san-francisco | 66        |
| `schedule-amc-kabuki-8-2026-08-13.json`     | AMC Kabuki 8 (`amc:theatre:4145`)    | san-francisco | 27        |
| `schedule-amc-southlake-24-2026-08-13.json` | AMC Southlake 24 (`amc:theatre:416`) | atlanta       | 104       |

Every performance in these bodies carries a real 2026-08-13 local calendar date as captured.
The seed script and full-mode fixture fetch seam shift those timestamps to the requested date
(preserving wall-clock times), so seeded and fetched schedules stay inside the search range.
Query the date printed by `seed`, not a hardcoded 2026-08-13.

## `seats/` — three re-keyed seat-map fixtures

Each file below is a byte-for-byte copy of a real captured body from
`packages/providers/fixtures/redacted/seats-*.json`, re-keyed on disk to a numeric showtime id
that also appears as a parsed performance in one of the `schedule/*.json` bodies above, so the
same id resolves consistently through `SCHEDULE_RESOLUTION` (seeded from the schedule fixture)
and `SHOWTIME_FETCH`/`RECHECK` (seeded/served from this file):

| on-disk file           | source capture         | availability profile                                    | served showtime          | theatre                              | movie                             |
| ---------------------- | ---------------------- | ------------------------------------------------------- | ------------------------ | ------------------------------------ | --------------------------------- |
| `seats-145927008.json` | `seats-145817558.json` | spacious, mostly available — 165 seats, 144 available   | `amc:showtime:145927006` | AMC Metreon 16 (`amc:theatre:2325`)  | "Spider-Man: Brand New Day"       |
| `seats-146024502.json` | `seats-145835357.json` | busy small auditorium — 50 visible seats, 29 available  | `amc:showtime:146024502` | AMC Kabuki 8 (`amc:theatre:4145`)    | "The Invite" (`amc:movie:82975`)  |
| `seats-146089621.json` | `seats-145738252.json` | large busy auditorium — 186 visible seats, 95 available | `amc:showtime:146089621` | AMC Southlake 24 (`amc:theatre:416`) | "Toy Story 5" (`amc:movie:72482`) |

Re-keying mechanics differ:

- `seats-145927008.json` is a **two-stage** re-key: copied from `seats-145817558.json` and
  renamed, then re-keyed again at load time (dev seed and fetch seam) from `145927008` to
  `145927006`, the Dolby performance at 2026-08-14T01:30:00Z (18:30 local).
- `seats-146024502.json` and `seats-146089621.json` are **single-stage** re-keys: written
  directly to their final target id, so no load-time substitution happens — the seed's and the
  fetch seam's uniform replace-all is a harmless self-replacement for them.

This is a **synthetic pairing, not a captured one**: each original seat map was really observed
against a different theatre's showtime at a different real moment. Re-keying lets the same
numeric showtime id resolve consistently through both halves of the chain above — the chain the
real corpus cannot exercise today, since its 10 real seat-map captures share zero `showtimeId`
with any of its 14 captured schedule fixtures (confirmed by direct comparison). Seat layout
correctness (which physical auditorium a seat map "really" belongs to) is not something
`theatres.search`/`theatres.movies`/`showtimes.recheck` care about — only the bitmap and the
showtime id matter to those code paths.

The three pairings prove the chain end-to-end across different availability profiles
(`docker compose --profile full`; `showtimes.recheck` against any showtime in the table should
resolve `AVAILABLE`). To add another, see "Re-keying another seat fixture" in `dev/README.md`.
