# Fixture corpus

The adapter fixture regression suite is the CI gate for parser durability (architecture §9).

The specific ToS/robots.txt blockers were resolved on 2026-08-08 (per `docs/gates.md`),
authorizing a single strictly bounded live fixture-capture session. Decision owner Josh Wu
explicitly delegated the one-time preregistration and live operation to Codex. That session ran
on 2026-08-11 UTC and stopped after its first request returned HTTP 403 `UPSTREAM_BLOCKED`;
session (P7, `apps/server/scripts/capture-fixtures-browser.ts`, driving a real Chrome corridor
instead of P3's plain-fetch transport) ran on 2026-08-13 UTC under a separate, freshly logged
authorization and produced a 27-file redacted corpus** (`apps/server/fixtures/CAPTURE-LOG.md`).
**A fifth logged session (2026-08-15 UTC, same P7 script) captured the bare `/movie-theatres`
directory index and two `/movie-theatres/{marketSlug}` theatre-list pages (ADR 0021 shapes with
no prior corpus coverage), adding 3 more fixture/golden pairs (the two market pages plus the
bare directory index, which S26 promotes to a market-slug-list parser pair).** No session may
be rerun without its own new
logged human decision. ADR 0002 remains `proposed` overall (GDPR/CCPA items still open).

- `raw/` — captured HTML/RSC payloads, gitignored; never committed under any circumstance.
- `redacted/` — payloads that have passed `scripts/redact.ts`'s allowlist redactor. A file
  landing here is not automatically safe to commit — treat it as "processed", not "cleared",
  until the redactor's own open defects (docs/backlog.md P3 row) are resolved and each payload
  has been reviewed. Once genuinely cleared, these are what CI replays.
- Each fixture is paired with the expected normalized output (golden files) per §15 gate 7.

The corpus below is partially populated: 14 fixture/golden pairs (10 real seat-page captures,
the deliberately-invalid `showtimeId=0` case, two `/movie-theatres/{marketSlug}` market-page
captures — Atlanta and San Francisco — and the bare `/movie-theatres` directory index) are
committed and pass real parser normalization. The two
market-page goldens each hold real parsed `Theatre[]` output — Atlanta's 10 theatres
(ids 402,403,404,405,410,411,415,416,417,801) match the live re-fetch already recorded in
`docs/amc-catalogue-plan.md` §6.5. The 12 schedule and 3 theatre-search fixtures from the
2026-08-13 session are held out for now — their bodies do not contain the result/schedule data
their parsers expect, a real, currently-unresolved finding (`docs/backlog.md` P5 row) — and are
not yet committed. CI must never generate upstream traffic regardless of corpus state.

## Replay harness, golden convention, and CI (P2, `docs/backend-work-plan.md:671-705`)

This section documents the replay _machine_. It is no longer a machine waiting on an empty
corpus: the seat-page subset below already replays real captures through the real adapter
parsers.

**Pairing convention.** Every fixture `<name>.json` under `redacted/` pairs 1:1 with
`<name>.golden.json` in the same directory — the golden is the expected normalized output. A
fixture with no golden, or a golden with no fixture, is a bug in the corpus, not something the
harness tolerates.

The one `/movies` capture from the 2026-08-13 session is deliberately absent from this corpus:
no `VenueProvider` method consumes that route (an orphan in `src/amc/routes.ts`), so it has no
parser or golden to replay against. The bare `/movie-theatres` directory index from the
2026-08-15 session IS in the corpus (`theatres-directory-market-links.json`), paired with
`parseMarketSlugs` (S26.4): it is a market/state link list, not theatre records, so it has its
own link-scrape parser and golden rather than running through `parseTheatres` (which was
confirmed to correctly find nothing there).

**The harness — `packages/providers/test/support/replay.ts`.**

- Enumerates every `<name>.json`/`<name>.golden.json` pair under a directory (production use:
  `redacted/`), loads each fixture's JSON payload, and runs it through a parse/normalize step.
- **That step is `amcReplayNormalize`** (`test/support/amc-replay-normalize.ts`): the real
  `classifyResponse` → per-route parser (`parseTheatres`/`parseMarketSlugs`/`parseShowtimes`/`parseSeats`)
  pipeline `AmcProvider` runs in production, minus the network hop. The step is a parameter
  (`ReplayOptions.normalize`) so this file itself never had to change when the placeholder
  (`SeatPageResultSchema.parse`, P1/P2-era) was replaced with the real parsers.
- Diffs the normalized result against the golden — structurally, independent of JSON key order
  — and reports a `GOLDEN_MISMATCH` on any difference.
- **Fails loudly, never silently, on an orphan on either side** (`FIXTURE_WITHOUT_GOLDEN`,
  `GOLDEN_WITHOUT_FIXTURE`), and on a payload that does not parse (`NORMALIZE_FAILED`). An empty
  directory reports zero issues — that is the correct, non-vacuous state today, proven by
  `test/support/replay.self-test.test.ts` running the same code against synthetic, clearly
  labeled payloads under `test/support/__fixtures__/`, never against this directory.
- **Never regenerates a golden on its own.** Regeneration is explicit opt-in:
  `UPDATE_GOLDENS=1 pnpm --filter @seatfirst/providers test:fixtures` (equivalently,
  `pnpm --filter @seatfirst/providers test:update-goldens`). The harness module itself never
  reads `process.env`; `test/fixtures.replay.test.ts` is the one place that env var is read.

**CI (`.github/workflows/ci.yml`, job `fixture-regression`).** Runs a fixture-hygiene guard
(`packages/providers/scripts/check-fixture-hygiene.mjs` — fails the build if anything lands
under `raw/`, or a file under `redacted/` looks like an unredacted capture by a cheap,
documented heuristic — see that script's header for the exact rule and its limits) and then the
replay harness plus its self-test suite. No network call of any kind: everything here reads
fixtures already on disk.

## Fixture Capture and Log (P3)

The script `packages/providers/scripts/capture-fixtures.ts` is the intended single tool for
executing the authorized live session. Its implementation and offline verification are
complete. The one authorized session has now been consumed by the blocked run recorded in
`CAPTURE-LOG.md`; do not run it again under the 2026-08-10 authorization.

- **Execution (intended design)**: runs manually with the `--confirm-live-session=yes-i-understand`
  flag and an explicit operator, and refuses to run in CI (`SEATFIRST_ENV=ci`).
- **Safety bounds (intended design)**: wraps the transport with a hardcoded, unconfigurable
  budget of 150 logical top-level navigations and stops immediately on any upstream challenge
  (`CHALLENGE_REQUIRED` or `UPSTREAM_QUEUED`). Redirect document requests do not consume another
  policy unit but remain separately counted in the audit footprint.
- **Redaction**: every captured payload passes through `scripts/redact.ts` (an allowlist
  redactor) before being saved to `raw/`.
- **Log**: every execution appends to `CAPTURE-LOG.md` with the session route mix,
  classification results, and any abort reason. The log must never contain sensitive data or
  payload excerpts.
