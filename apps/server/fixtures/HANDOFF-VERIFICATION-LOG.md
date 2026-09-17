# Handoff-Verification Log (browser transport)

**Template — no session recorded yet.** S35 ships the _capability_ to run the handoff-
verification session ADR 0002 §3.5 proposes: the one live session, separately authorized by
Josh Wu at authorization time, that preregisters a set of seats deep links (with a declarative
observation plan for each) and a navigation budget, drives them through P6's Chrome corridor
(`apps/server/scripts/verify-handoff.ts`), and logs only the redacted factual answers — the
seat carry-through and the geometry of the sold/unavailable seats observed near each target.

No live session has been authorized or run for this task, and none is revived by running the
entrypoint (ADR 0002 §3.5): the entrypoint independently refuses without an explicit
non-default `--confirm-live-session=yes-i-understand` flag, refuses in `SEATFIRST_ENV=ci`, and
requires `VERIFY_TARGETS_FILE` plus `VERIFY_NAVIGATION_BUDGET` to be supplied explicitly. This
file is appended by the entrypoint (to `apps/server/fixtures/HANDOFF-VERIFICATION-LOG.md`)
each time a session is _separately_ authorized.

## Log format

Each session writes one fenced `text` block:

- **Header** — `## Session started at <ISO-8601>`, the operator, the navigation budget, and
  one `Target: <seats deep link>` line per preregistered target.
- **Per navigation** — an `[ATTEMPT]` line with the outcome kind (and HTTP status when the
  transport has one), one `hop N/M:` line per `DocumentHop` corridor stage with its
  classification and status, and the `subresourceAborts` count on success.
- **Observation answers (success only, S35.6)** — a `carry-through:` line answering whether any
  seat rendered pre-selected/highlighted (`selected=<id>`, `NONE_SELECTED`, or `INCONCLUSIVE`),
  followed by one `geometry:` line per sold/unavailable seat observed near the target with its
  row, column, name, availability, and status.
- **Abort** — `[ABORT] Non-success navigation outcome <KIND>. Aborting session.` (or
  `[ABORT] Fatal error encountered.`). Every non-success outcome ends the whole session; the
  entrypoint never skip-and-continues.
- **Summary** — `Session ended. Aborted: <true|false>. Navigations spent: <spent>/<budget>.`

Every value is allowlist-shaped redaction output (S35.7): fields outside the named allowlist
are dropped, and retained free-text is scrubbed through P3/P7's `redact()`, so no cookie,
auth/session token, IP address, or Cloudflare/Queue-it trace identifier is ever written.

## Illustrative format (not a recorded session)

```text
## Session started at <ISO-8601 timestamp>
Operator: <operator name>
Navigation budget: <N>
Target: https://www.amctheatres.com/showtimes/<showtime-id>/seats
[ATTEMPT] <ISO-8601 timestamp> | https://www.amctheatres.com/showtimes/<showtime-id>/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: <N>
  carry-through: selected=A26
  geometry: row=3 column=4 name=A26 available=false status=sold
Session ended. Aborted: false. Navigations spent: 1/<N>.
```

```text
## Session started at 2026-08-17T17:13:32.548Z
Operator: Josh Wu
Navigation budget: 5
Target: https://www.amctheatres.com/showtimes/145488986/seats
Target: https://www.amctheatres.com/showtimes/146079040/seats
Target: https://www.amctheatres.com/showtimes/145488983/seats
Target: https://www.amctheatres.com/showtimes/145488983/seats
Target: https://www.amctheatres.com/showtimes/145488986/seats
[ATTEMPT] 2026-08-17T17:13:35.882Z | https://www.amctheatres.com/showtimes/145488986/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
[ATTEMPT] 2026-08-17T17:13:37.567Z | https://www.amctheatres.com/showtimes/146079040/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
[ATTEMPT] 2026-08-17T17:13:39.392Z | https://www.amctheatres.com/showtimes/145488983/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
[ATTEMPT] 2026-08-17T17:13:41.055Z | https://www.amctheatres.com/showtimes/145488983/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
[ATTEMPT] 2026-08-17T17:13:42.843Z | https://www.amctheatres.com/showtimes/145488986/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
Session ended. Aborted: false. Navigations spent: 5/5.
```

```text
## Session started at 2026-08-17T21:34:13.675Z
Operator: Josh Wu
Navigation budget: 3
Target: https://www.amctheatres.com/showtimes/145488986/seats
Target: https://www.amctheatres.com/showtimes/146079040/seats
Target: https://www.amctheatres.com/showtimes/145488983/seats
[ATTEMPT] 2026-08-17T21:34:16.899Z | https://www.amctheatres.com/showtimes/145488986/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=1 column=7 name=A14 available=true status=null
  geometry: row=1 column=8 name=A13 available=true status=null
  geometry: row=1 column=9 name=A12 available=true status=null
  geometry: row=1 column=10 name=A11 available=true status=null
  geometry: row=1 column=11 name=A10 available=true status=null
  geometry: row=1 column=12 name=A9 available=true status=null
  geometry: row=1 column=13 name=A8 available=true status=null
  geometry: row=1 column=14 name=A7 available=true status=null
  geometry: row=1 column=15 name=A6 available=true status=null
  geometry: row=1 column=16 name=A5 available=true status=null
  geometry: row=1 column=17 name=A4 available=true status=null
  geometry: row=2 column=7 name=B16 available=true status=null
  geometry: row=2 column=8 name=B15 available=true status=null
  geometry: row=2 column=9 name=B14 available=true status=null
  geometry: row=2 column=10 name=B13 available=true status=null
  geometry: row=2 column=11 name=B12 available=true status=null
  geometry: row=2 column=12 name=B11 available=true status=null
  geometry: row=2 column=13 name=B10 available=true status=null
  geometry: row=2 column=14 name=B9 available=true status=null
  geometry: row=2 column=15 name=B8 available=true status=null
  geometry: row=2 column=16 name=B7 available=true status=null
  geometry: row=2 column=17 name=B6 available=true status=null
  geometry: row=3 column=7 name= available=false status=null
  geometry: row=3 column=8 name= available=false status=null
  geometry: row=3 column=9 name= available=false status=null
  geometry: row=3 column=10 name= available=false status=null
  geometry: row=3 column=11 name= available=false status=null
  geometry: row=3 column=12 name= available=false status=null
  geometry: row=3 column=13 name= available=false status=null
  geometry: row=3 column=14 name= available=false status=null
[ATTEMPT] 2026-08-17T21:34:18.448Z | https://www.amctheatres.com/showtimes/146079040/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=1 column=1 name= available=false status=null
  geometry: row=1 column=2 name=A7 available=true status=null
  geometry: row=1 column=3 name=A6 available=true status=null
  geometry: row=1 column=4 name=A5 available=true status=null
  geometry: row=1 column=5 name=A4 available=true status=null
  geometry: row=1 column=6 name=A3 available=true status=null
  geometry: row=1 column=7 name=A2 available=true status=null
  geometry: row=1 column=8 name=A1 available=true status=null
  geometry: row=1 column=9 name= available=false status=null
  geometry: row=2 column=1 name= available=false status=null
  geometry: row=2 column=2 name=B7 available=true status=null
  geometry: row=2 column=3 name=B6 available=true status=null
  geometry: row=2 column=4 name=B5 available=true status=null
  geometry: row=2 column=5 name=B4 available=true status=null
  geometry: row=2 column=6 name=B3 available=true status=null
  geometry: row=2 column=7 name=B2 available=true status=null
  geometry: row=2 column=8 name=B1 available=true status=null
  geometry: row=2 column=9 name= available=false status=null
  geometry: row=3 column=1 name= available=false status=null
  geometry: row=3 column=2 name=C6 available=true status=null
  geometry: row=3 column=3 name=C5 available=true status=null
  geometry: row=3 column=4 name=C4 available=true status=null
  geometry: row=3 column=5 name=C3 available=true status=null
  geometry: row=3 column=6 name= available=false status=null
  geometry: row=3 column=7 name=C2 available=true status=null
  geometry: row=3 column=8 name=C1 available=true status=null
  geometry: row=3 column=9 name= available=false status=null
  geometry: row=4 column=1 name= available=false status=null
  geometry: row=4 column=2 name= available=false status=null
  geometry: row=4 column=3 name= available=false status=null
[ATTEMPT] 2026-08-17T21:34:20.221Z | https://www.amctheatres.com/showtimes/145488983/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=3 column=18 name= available=false status=null
  geometry: row=3 column=19 name= available=false status=null
  geometry: row=3 column=20 name= available=false status=null
  geometry: row=3 column=21 name= available=false status=null
  geometry: row=3 column=22 name= available=false status=null
  geometry: row=3 column=23 name= available=false status=null
  geometry: row=4 column=18 name=C2 available=false status=null
  geometry: row=4 column=19 name=C1 available=false status=null
  geometry: row=4 column=20 name= available=false status=null
  geometry: row=4 column=21 name= available=false status=null
  geometry: row=4 column=22 name= available=false status=null
  geometry: row=4 column=23 name= available=false status=null
  geometry: row=5 column=18 name=D3 available=false status=null
  geometry: row=5 column=19 name=D2 available=false status=null
  geometry: row=5 column=20 name=D1 available=true status=null
  geometry: row=5 column=21 name= available=false status=null
  geometry: row=5 column=22 name= available=false status=null
  geometry: row=5 column=23 name= available=false status=null
  geometry: row=6 column=18 name=E3 available=false status=null
  geometry: row=6 column=19 name=E2 available=false status=null
  geometry: row=6 column=20 name=E1 available=false status=null
  geometry: row=6 column=21 name= available=false status=null
  geometry: row=6 column=22 name= available=false status=null
  geometry: row=6 column=23 name= available=false status=null
  geometry: row=7 column=18 name=F3 available=false status=null
  geometry: row=7 column=19 name=F2 available=false status=null
  geometry: row=7 column=20 name=F1 available=false status=null
  geometry: row=7 column=21 name= available=false status=null
  geometry: row=7 column=22 name= available=false status=null
  geometry: row=7 column=23 name= available=false status=null
Session ended. Aborted: false. Navigations spent: 3/3.
```

```text
## Session started at 2026-08-17T21:59:04.928Z
Operator: Josh Wu
Navigation budget: 3
Target: https://www.amctheatres.com/showtimes/145488986/seats
Target: https://www.amctheatres.com/showtimes/146079040/seats
Target: https://www.amctheatres.com/showtimes/145488983/seats
[ATTEMPT] 2026-08-17T21:59:08.056Z | https://www.amctheatres.com/showtimes/145488986/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=1 column=1 name= available=false status=null
  geometry: row=1 column=2 name= available=false status=null
  geometry: row=1 column=3 name= available=false status=null
  geometry: row=1 column=4 name= available=false status=null
  geometry: row=1 column=5 name=A16 available=true status=null
  geometry: row=1 column=6 name=A15 available=true status=null
  geometry: row=1 column=7 name=A14 available=true status=null
  geometry: row=1 column=8 name=A13 available=true status=null
  geometry: row=1 column=9 name=A12 available=true status=null
  geometry: row=1 column=10 name=A11 available=true status=null
  geometry: row=1 column=11 name=A10 available=true status=null
  geometry: row=1 column=12 name=A9 available=true status=null
  geometry: row=1 column=13 name=A8 available=true status=null
  geometry: row=1 column=14 name=A7 available=true status=null
  geometry: row=1 column=15 name=A6 available=true status=null
  geometry: row=1 column=16 name=A5 available=true status=null
  geometry: row=1 column=17 name=A4 available=true status=null
  geometry: row=1 column=18 name=A3 available=true status=null
  geometry: row=1 column=19 name=A2 available=true status=null
  geometry: row=1 column=20 name=A1 available=true status=null
  geometry: row=1 column=21 name= available=false status=null
  geometry: row=1 column=22 name= available=false status=null
  geometry: row=1 column=23 name= available=false status=null
  geometry: row=2 column=1 name= available=false status=null
  geometry: row=2 column=2 name= available=false status=null
  geometry: row=2 column=3 name=B20 available=true status=null
  geometry: row=2 column=4 name=B19 available=true status=null
  geometry: row=2 column=5 name=B18 available=true status=null
  geometry: row=2 column=6 name=B17 available=true status=null
  geometry: row=2 column=7 name=B16 available=true status=null
  geometry: row=2 column=8 name=B15 available=true status=null
  geometry: row=2 column=9 name=B14 available=true status=null
  geometry: row=2 column=10 name=B13 available=true status=null
  geometry: row=2 column=11 name=B12 available=true status=null
  geometry: row=2 column=12 name=B11 available=true status=null
  geometry: row=2 column=13 name=B10 available=true status=null
  geometry: row=2 column=14 name=B9 available=true status=null
  geometry: row=2 column=15 name=B8 available=true status=null
  geometry: row=2 column=16 name=B7 available=true status=null
  geometry: row=2 column=17 name=B6 available=true status=null
  geometry: row=2 column=18 name=B5 available=true status=null
  geometry: row=2 column=19 name=B4 available=true status=null
  geometry: row=2 column=20 name=B3 available=true status=null
  geometry: row=2 column=21 name=B2 available=true status=null
  geometry: row=2 column=22 name=B1 available=true status=null
  geometry: row=2 column=23 name= available=false status=null
  geometry: row=3 column=1 name= available=false status=null
  geometry: row=3 column=2 name= available=false status=null
  geometry: row=3 column=3 name= available=false status=null
  geometry: row=3 column=4 name= available=false status=null
  geometry: row=3 column=5 name= available=false status=null
  geometry: row=3 column=6 name= available=false status=null
  geometry: row=3 column=7 name= available=false status=null
  geometry: row=3 column=8 name= available=false status=null
  geometry: row=3 column=9 name= available=false status=null
  geometry: row=3 column=10 name= available=false status=null
  geometry: row=3 column=11 name= available=false status=null
  geometry: row=3 column=12 name= available=false status=null
  geometry: row=3 column=13 name= available=false status=null
  geometry: row=3 column=14 name= available=false status=null
  geometry: row=3 column=15 name= available=false status=null
  geometry: row=3 column=16 name= available=false status=null
  geometry: row=3 column=17 name= available=false status=null
  geometry: row=3 column=18 name= available=false status=null
  geometry: row=3 column=19 name= available=false status=null
  geometry: row=3 column=20 name= available=false status=null
  geometry: row=3 column=21 name= available=false status=null
  geometry: row=3 column=22 name= available=false status=null
  geometry: row=3 column=23 name= available=false status=null
  geometry: row=4 column=1 name= available=false status=null
  geometry: row=4 column=2 name= available=false status=null
  geometry: row=4 column=3 name=C16 available=false status=null
  geometry: row=4 column=4 name=C15 available=true status=null
  geometry: row=4 column=5 name=C14 available=true status=null
  geometry: row=4 column=6 name=C13 available=true status=null
  geometry: row=4 column=7 name=C12 available=true status=null
  geometry: row=4 column=8 name=C11 available=true status=null
  geometry: row=4 column=9 name=C10 available=true status=null
  geometry: row=4 column=10 name= available=false status=null
  geometry: row=4 column=11 name=C9 available=true status=null
  geometry: row=4 column=12 name=C8 available=false status=null
  geometry: row=4 column=13 name=C7 available=true status=null
  geometry: row=4 column=14 name=C6 available=true status=null
  geometry: row=4 column=15 name=C5 available=true status=null
  geometry: row=4 column=16 name=C4 available=false status=null
  geometry: row=4 column=17 name=C3 available=true status=null
  geometry: row=4 column=18 name=C2 available=true status=null
  geometry: row=4 column=19 name=C1 available=true status=null
  geometry: row=4 column=20 name= available=false status=null
  geometry: row=4 column=21 name= available=false status=null
  geometry: row=4 column=22 name= available=false status=null
  geometry: row=4 column=23 name= available=false status=null
  geometry: row=5 column=1 name= available=false status=null
  geometry: row=5 column=2 name= available=false status=null
  geometry: row=5 column=3 name=D18 available=true status=null
  geometry: row=5 column=4 name=D17 available=true status=null
  geometry: row=5 column=5 name=D16 available=true status=null
  geometry: row=5 column=6 name=D15 available=false status=null
  geometry: row=5 column=7 name=D14 available=false status=null
  geometry: row=5 column=8 name=D13 available=true status=null
  geometry: row=5 column=9 name=D12 available=false status=null
  geometry: row=5 column=10 name=D11 available=false status=null
  geometry: row=5 column=11 name=D10 available=false status=null
  geometry: row=5 column=12 name=D9 available=false status=null
  geometry: row=5 column=13 name=D8 available=false status=null
  geometry: row=5 column=14 name=D7 available=false status=null
  geometry: row=5 column=15 name=D6 available=false status=null
  geometry: row=5 column=16 name=D5 available=true status=null
  geometry: row=5 column=17 name=D4 available=true status=null
  geometry: row=5 column=18 name=D3 available=false status=null
  geometry: row=5 column=19 name=D2 available=true status=null
  geometry: row=5 column=20 name=D1 available=true status=null
  geometry: row=5 column=21 name= available=false status=null
  geometry: row=5 column=22 name= available=false status=null
  geometry: row=5 column=23 name= available=false status=null
  geometry: row=6 column=1 name= available=false status=null
  geometry: row=6 column=2 name= available=false status=null
  geometry: row=6 column=3 name=E18 available=false status=null
  geometry: row=6 column=4 name=E17 available=false status=null
  geometry: row=6 column=5 name=E16 available=false status=null
  geometry: row=6 column=6 name=E15 available=true status=null
  geometry: row=6 column=7 name=E14 available=false status=null
  geometry: row=6 column=8 name=E13 available=false status=null
  geometry: row=6 column=9 name=E12 available=false status=null
  geometry: row=6 column=10 name=E11 available=false status=null
  geometry: row=6 column=11 name=E10 available=false status=null
  geometry: row=6 column=12 name=E9 available=false status=null
  geometry: row=6 column=13 name=E8 available=false status=null
  geometry: row=6 column=14 name=E7 available=false status=null
  geometry: row=6 column=15 name=E6 available=false status=null
  geometry: row=6 column=16 name=E5 available=false status=null
  geometry: row=6 column=17 name=E4 available=false status=null
  geometry: row=6 column=18 name=E3 available=false status=null
  geometry: row=6 column=19 name=E2 available=false status=null
  geometry: row=6 column=20 name=E1 available=false status=null
  geometry: row=6 column=21 name= available=false status=null
  geometry: row=6 column=22 name= available=false status=null
  geometry: row=6 column=23 name= available=false status=null
  geometry: row=7 column=1 name= available=false status=null
  geometry: row=7 column=2 name= available=false status=null
  geometry: row=7 column=3 name=F18 available=false status=null
  geometry: row=7 column=4 name=F17 available=false status=null
  geometry: row=7 column=5 name=F16 available=false status=null
  geometry: row=7 column=6 name=F15 available=false status=null
  geometry: row=7 column=7 name=F14 available=false status=null
  geometry: row=7 column=8 name=F13 available=false status=null
  geometry: row=7 column=9 name=F12 available=false status=null
  geometry: row=7 column=10 name=F11 available=false status=null
  geometry: row=7 column=11 name=F10 available=false status=null
  geometry: row=7 column=12 name=F9 available=false status=null
  geometry: row=7 column=13 name=F8 available=false status=null
  geometry: row=7 column=14 name=F7 available=false status=null
  geometry: row=7 column=15 name=F6 available=false status=null
  geometry: row=7 column=16 name=F5 available=false status=null
  geometry: row=7 column=17 name=F4 available=true status=null
  geometry: row=7 column=18 name=F3 available=true status=null
  geometry: row=7 column=19 name=F2 available=false status=null
  geometry: row=7 column=20 name=F1 available=false status=null
  geometry: row=7 column=21 name= available=false status=null
  geometry: row=7 column=22 name= available=false status=null
  geometry: row=7 column=23 name= available=false status=null
  geometry: row=8 column=1 name=G23 available=true status=null
  geometry: row=8 column=2 name=G22 available=true status=null
  geometry: row=8 column=3 name=G21 available=true status=null
  geometry: row=8 column=4 name=G20 available=true status=null
  geometry: row=8 column=5 name=G19 available=false status=null
  geometry: row=8 column=6 name=G18 available=false status=null
  geometry: row=8 column=7 name=G17 available=false status=null
  geometry: row=8 column=8 name=G16 available=false status=null
  geometry: row=8 column=9 name=G15 available=false status=null
  geometry: row=8 column=10 name=G14 available=false status=null
  geometry: row=8 column=11 name=G13 available=false status=null
  geometry: row=8 column=12 name=G12 available=false status=null
  geometry: row=8 column=13 name=G11 available=false status=null
  geometry: row=8 column=14 name=G10 available=false status=null
  geometry: row=8 column=15 name=G9 available=false status=null
  geometry: row=8 column=16 name=G8 available=false status=null
  geometry: row=8 column=17 name=G7 available=false status=null
  geometry: row=8 column=18 name=G6 available=false status=null
  geometry: row=8 column=19 name=G5 available=false status=null
  geometry: row=8 column=20 name=G4 available=false status=null
  geometry: row=8 column=21 name=G3 available=true status=null
  geometry: row=8 column=22 name=G2 available=true status=null
  geometry: row=8 column=23 name=G1 available=true status=null
  geometry: row=9 column=1 name=H23 available=true status=null
  geometry: row=9 column=2 name=H22 available=true status=null
  geometry: row=9 column=3 name=H21 available=false status=null
  geometry: row=9 column=4 name=H20 available=false status=null
  geometry: row=9 column=5 name=H19 available=false status=null
  geometry: row=9 column=6 name=H18 available=false status=null
  geometry: row=9 column=7 name=H17 available=false status=null
  geometry: row=9 column=8 name=H16 available=false status=null
  geometry: row=9 column=9 name=H15 available=false status=null
  geometry: row=9 column=10 name=H14 available=false status=null
  geometry: row=9 column=11 name=H13 available=false status=null
  geometry: row=9 column=12 name=H12 available=false status=null
  geometry: row=9 column=13 name=H11 available=false status=null
  geometry: row=9 column=14 name=H10 available=false status=null
  geometry: row=9 column=15 name=H9 available=true status=null
  geometry: row=9 column=16 name=H8 available=false status=null
  geometry: row=9 column=17 name=H7 available=false status=null
  geometry: row=9 column=18 name=H6 available=false status=null
  geometry: row=9 column=19 name=H5 available=true status=null
  geometry: row=9 column=20 name=H4 available=true status=null
  geometry: row=9 column=21 name=H3 available=false status=null
  geometry: row=9 column=22 name=H2 available=false status=null
  geometry: row=9 column=23 name=H1 available=true status=null
  geometry: row=10 column=1 name=J22 available=true status=null
  geometry: row=10 column=2 name=J21 available=false status=null
  geometry: row=10 column=3 name=J20 available=false status=null
  geometry: row=10 column=4 name=J19 available=true status=null
  geometry: row=10 column=5 name=J18 available=true status=null
  geometry: row=10 column=6 name=J17 available=false status=null
  geometry: row=10 column=7 name=J16 available=false status=null
  geometry: row=10 column=8 name=J15 available=false status=null
  geometry: row=10 column=9 name=J14 available=false status=null
  geometry: row=10 column=10 name= available=false status=null
  geometry: row=10 column=11 name= available=false status=null
  geometry: row=10 column=12 name= available=false status=null
  geometry: row=10 column=13 name= available=false status=null
  geometry: row=10 column=14 name=J9 available=false status=null
  geometry: row=10 column=15 name=J8 available=true status=null
  geometry: row=10 column=16 name=J7 available=true status=null
  geometry: row=10 column=17 name= available=false status=null
  geometry: row=10 column=18 name=J6 available=true status=null
  geometry: row=10 column=19 name=J5 available=true status=null
  geometry: row=10 column=20 name=J4 available=true status=null
  geometry: row=10 column=21 name=J3 available=true status=null
  geometry: row=10 column=22 name=J2 available=true status=null
  geometry: row=10 column=23 name=J1 available=true status=null
  geometry: row=11 column=1 name=K6 available=true status=null
  geometry: row=11 column=2 name=K5 available=true status=null
  geometry: row=11 column=3 name=K4 available=true status=null
  geometry: row=11 column=4 name=K3 available=true status=null
  geometry: row=11 column=5 name=K2 available=false status=null
  geometry: row=11 column=6 name=K1 available=false status=null
  geometry: row=11 column=7 name= available=false status=null
  geometry: row=11 column=8 name= available=false status=null
  geometry: row=11 column=9 name= available=false status=null
  geometry: row=11 column=10 name= available=false status=null
  geometry: row=11 column=11 name= available=false status=null
  geometry: row=11 column=12 name= available=false status=null
  geometry: row=11 column=13 name= available=false status=null
  geometry: row=11 column=14 name= available=false status=null
  geometry: row=11 column=15 name= available=false status=null
  geometry: row=11 column=16 name= available=false status=null
  geometry: row=11 column=17 name= available=false status=null
  geometry: row=11 column=18 name= available=false status=null
  geometry: row=11 column=19 name= available=false status=null
  geometry: row=11 column=20 name= available=false status=null
  geometry: row=11 column=21 name= available=false status=null
  geometry: row=11 column=22 name= available=false status=null
  geometry: row=11 column=23 name= available=false status=null
[ATTEMPT] 2026-08-17T21:59:10.377Z | https://www.amctheatres.com/showtimes/146079040/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=1 column=1 name= available=false status=null
  geometry: row=1 column=2 name=A7 available=true status=null
  geometry: row=1 column=3 name=A6 available=true status=null
  geometry: row=1 column=4 name=A5 available=true status=null
  geometry: row=1 column=5 name=A4 available=true status=null
  geometry: row=1 column=6 name=A3 available=true status=null
  geometry: row=1 column=7 name=A2 available=true status=null
  geometry: row=1 column=8 name=A1 available=true status=null
  geometry: row=1 column=9 name= available=false status=null
  geometry: row=2 column=1 name= available=false status=null
  geometry: row=2 column=2 name=B7 available=true status=null
  geometry: row=2 column=3 name=B6 available=true status=null
  geometry: row=2 column=4 name=B5 available=true status=null
  geometry: row=2 column=5 name=B4 available=true status=null
  geometry: row=2 column=6 name=B3 available=true status=null
  geometry: row=2 column=7 name=B2 available=true status=null
  geometry: row=2 column=8 name=B1 available=true status=null
  geometry: row=2 column=9 name= available=false status=null
  geometry: row=3 column=1 name= available=false status=null
  geometry: row=3 column=2 name=C6 available=true status=null
  geometry: row=3 column=3 name=C5 available=true status=null
  geometry: row=3 column=4 name=C4 available=true status=null
  geometry: row=3 column=5 name=C3 available=true status=null
  geometry: row=3 column=6 name= available=false status=null
  geometry: row=3 column=7 name=C2 available=true status=null
  geometry: row=3 column=8 name=C1 available=true status=null
  geometry: row=3 column=9 name= available=false status=null
  geometry: row=4 column=1 name= available=false status=null
  geometry: row=4 column=2 name= available=false status=null
  geometry: row=4 column=3 name= available=false status=null
  geometry: row=4 column=4 name= available=false status=null
  geometry: row=4 column=5 name= available=false status=null
  geometry: row=4 column=6 name= available=false status=null
  geometry: row=4 column=7 name= available=false status=null
  geometry: row=4 column=8 name= available=false status=null
  geometry: row=4 column=9 name= available=false status=null
  geometry: row=5 column=1 name= available=false status=null
  geometry: row=5 column=2 name= available=false status=null
  geometry: row=5 column=3 name= available=false status=null
  geometry: row=5 column=4 name=D5 available=false status=null
  geometry: row=5 column=5 name=D4 available=false status=null
  geometry: row=5 column=6 name=D3 available=false status=null
  geometry: row=5 column=7 name=D2 available=false status=null
  geometry: row=5 column=8 name=D1 available=true status=null
  geometry: row=5 column=9 name= available=false status=null
  geometry: row=6 column=1 name= available=false status=null
  geometry: row=6 column=2 name= available=false status=null
  geometry: row=6 column=3 name= available=false status=null
  geometry: row=6 column=4 name=E5 available=false status=null
  geometry: row=6 column=5 name=E4 available=false status=null
  geometry: row=6 column=6 name=E3 available=false status=null
  geometry: row=6 column=7 name=E2 available=false status=null
  geometry: row=6 column=8 name=E1 available=true status=null
  geometry: row=6 column=9 name= available=false status=null
  geometry: row=7 column=1 name= available=false status=null
  geometry: row=7 column=2 name= available=false status=null
  geometry: row=7 column=3 name= available=false status=null
  geometry: row=7 column=4 name=F5 available=true status=null
  geometry: row=7 column=5 name=F4 available=false status=null
  geometry: row=7 column=6 name=F3 available=false status=null
  geometry: row=7 column=7 name=F2 available=false status=null
  geometry: row=7 column=8 name=F1 available=true status=null
  geometry: row=7 column=9 name= available=false status=null
  geometry: row=8 column=1 name= available=false status=null
  geometry: row=8 column=2 name= available=false status=null
  geometry: row=8 column=3 name=G6 available=false status=null
  geometry: row=8 column=4 name=G5 available=false status=null
  geometry: row=8 column=5 name=G4 available=true status=null
  geometry: row=8 column=6 name=G3 available=true status=null
  geometry: row=8 column=7 name=G2 available=true status=null
  geometry: row=8 column=8 name=G1 available=true status=null
  geometry: row=8 column=9 name= available=false status=null
[ATTEMPT] 2026-08-17T21:59:12.236Z | https://www.amctheatres.com/showtimes/145488983/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
  carry-through: INCONCLUSIVE
  geometry: row=1 column=1 name= available=false status=null
  geometry: row=1 column=2 name= available=false status=null
  geometry: row=1 column=3 name= available=false status=null
  geometry: row=1 column=4 name= available=false status=null
  geometry: row=1 column=5 name=A16 available=true status=null
  geometry: row=1 column=6 name=A15 available=true status=null
  geometry: row=1 column=7 name=A14 available=true status=null
  geometry: row=1 column=8 name=A13 available=true status=null
  geometry: row=1 column=9 name=A12 available=true status=null
  geometry: row=1 column=10 name=A11 available=true status=null
  geometry: row=1 column=11 name=A10 available=true status=null
  geometry: row=1 column=12 name=A9 available=true status=null
  geometry: row=1 column=13 name=A8 available=true status=null
  geometry: row=1 column=14 name=A7 available=true status=null
  geometry: row=1 column=15 name=A6 available=true status=null
  geometry: row=1 column=16 name=A5 available=true status=null
  geometry: row=1 column=17 name=A4 available=true status=null
  geometry: row=1 column=18 name=A3 available=true status=null
  geometry: row=1 column=19 name=A2 available=true status=null
  geometry: row=1 column=20 name=A1 available=true status=null
  geometry: row=1 column=21 name= available=false status=null
  geometry: row=1 column=22 name= available=false status=null
  geometry: row=1 column=23 name= available=false status=null
  geometry: row=2 column=1 name= available=false status=null
  geometry: row=2 column=2 name= available=false status=null
  geometry: row=2 column=3 name=B20 available=true status=null
  geometry: row=2 column=4 name=B19 available=true status=null
  geometry: row=2 column=5 name=B18 available=true status=null
  geometry: row=2 column=6 name=B17 available=true status=null
  geometry: row=2 column=7 name=B16 available=true status=null
  geometry: row=2 column=8 name=B15 available=true status=null
  geometry: row=2 column=9 name=B14 available=true status=null
  geometry: row=2 column=10 name=B13 available=true status=null
  geometry: row=2 column=11 name=B12 available=false status=null
  geometry: row=2 column=12 name=B11 available=false status=null
  geometry: row=2 column=13 name=B10 available=false status=null
  geometry: row=2 column=14 name=B9 available=false status=null
  geometry: row=2 column=15 name=B8 available=false status=null
  geometry: row=2 column=16 name=B7 available=false status=null
  geometry: row=2 column=17 name=B6 available=true status=null
  geometry: row=2 column=18 name=B5 available=true status=null
  geometry: row=2 column=19 name=B4 available=false status=null
  geometry: row=2 column=20 name=B3 available=false status=null
  geometry: row=2 column=21 name=B2 available=false status=null
  geometry: row=2 column=22 name=B1 available=true status=null
  geometry: row=2 column=23 name= available=false status=null
  geometry: row=3 column=1 name= available=false status=null
  geometry: row=3 column=2 name= available=false status=null
  geometry: row=3 column=3 name= available=false status=null
  geometry: row=3 column=4 name= available=false status=null
  geometry: row=3 column=5 name= available=false status=null
  geometry: row=3 column=6 name= available=false status=null
  geometry: row=3 column=7 name= available=false status=null
  geometry: row=3 column=8 name= available=false status=null
  geometry: row=3 column=9 name= available=false status=null
  geometry: row=3 column=10 name= available=false status=null
  geometry: row=3 column=11 name= available=false status=null
  geometry: row=3 column=12 name= available=false status=null
  geometry: row=3 column=13 name= available=false status=null
  geometry: row=3 column=14 name= available=false status=null
  geometry: row=3 column=15 name= available=false status=null
  geometry: row=3 column=16 name= available=false status=null
  geometry: row=3 column=17 name= available=false status=null
  geometry: row=3 column=18 name= available=false status=null
  geometry: row=3 column=19 name= available=false status=null
  geometry: row=3 column=20 name= available=false status=null
  geometry: row=3 column=21 name= available=false status=null
  geometry: row=3 column=22 name= available=false status=null
  geometry: row=3 column=23 name= available=false status=null
  geometry: row=4 column=1 name= available=false status=null
  geometry: row=4 column=2 name= available=false status=null
  geometry: row=4 column=3 name=C16 available=false status=null
  geometry: row=4 column=4 name=C15 available=false status=null
  geometry: row=4 column=5 name=C14 available=false status=null
  geometry: row=4 column=6 name=C13 available=false status=null
  geometry: row=4 column=7 name=C12 available=false status=null
  geometry: row=4 column=8 name=C11 available=true status=null
  geometry: row=4 column=9 name=C10 available=true status=null
  geometry: row=4 column=10 name= available=false status=null
  geometry: row=4 column=11 name=C9 available=true status=null
  geometry: row=4 column=12 name=C8 available=false status=null
  geometry: row=4 column=13 name=C7 available=false status=null
  geometry: row=4 column=14 name=C6 available=true status=null
  geometry: row=4 column=15 name=C5 available=true status=null
  geometry: row=4 column=16 name=C4 available=false status=null
  geometry: row=4 column=17 name=C3 available=false status=null
  geometry: row=4 column=18 name=C2 available=false status=null
  geometry: row=4 column=19 name=C1 available=false status=null
  geometry: row=4 column=20 name= available=false status=null
  geometry: row=4 column=21 name= available=false status=null
  geometry: row=4 column=22 name= available=false status=null
  geometry: row=4 column=23 name= available=false status=null
  geometry: row=5 column=1 name= available=false status=null
  geometry: row=5 column=2 name= available=false status=null
  geometry: row=5 column=3 name=D18 available=false status=null
  geometry: row=5 column=4 name=D17 available=false status=null
  geometry: row=5 column=5 name=D16 available=false status=null
  geometry: row=5 column=6 name=D15 available=false status=null
  geometry: row=5 column=7 name=D14 available=false status=null
  geometry: row=5 column=8 name=D13 available=false status=null
  geometry: row=5 column=9 name=D12 available=false status=null
  geometry: row=5 column=10 name=D11 available=false status=null
  geometry: row=5 column=11 name=D10 available=false status=null
  geometry: row=5 column=12 name=D9 available=false status=null
  geometry: row=5 column=13 name=D8 available=false status=null
  geometry: row=5 column=14 name=D7 available=false status=null
  geometry: row=5 column=15 name=D6 available=false status=null
  geometry: row=5 column=16 name=D5 available=false status=null
  geometry: row=5 column=17 name=D4 available=false status=null
  geometry: row=5 column=18 name=D3 available=false status=null
  geometry: row=5 column=19 name=D2 available=false status=null
  geometry: row=5 column=20 name=D1 available=true status=null
  geometry: row=5 column=21 name= available=false status=null
  geometry: row=5 column=22 name= available=false status=null
  geometry: row=5 column=23 name= available=false status=null
  geometry: row=6 column=1 name= available=false status=null
  geometry: row=6 column=2 name= available=false status=null
  geometry: row=6 column=3 name=E18 available=false status=null
  geometry: row=6 column=4 name=E17 available=false status=null
  geometry: row=6 column=5 name=E16 available=false status=null
  geometry: row=6 column=6 name=E15 available=false status=null
  geometry: row=6 column=7 name=E14 available=false status=null
  geometry: row=6 column=8 name=E13 available=false status=null
  geometry: row=6 column=9 name=E12 available=false status=null
  geometry: row=6 column=10 name=E11 available=false status=null
  geometry: row=6 column=11 name=E10 available=false status=null
  geometry: row=6 column=12 name=E9 available=false status=null
  geometry: row=6 column=13 name=E8 available=false status=null
  geometry: row=6 column=14 name=E7 available=false status=null
  geometry: row=6 column=15 name=E6 available=false status=null
  geometry: row=6 column=16 name=E5 available=false status=null
  geometry: row=6 column=17 name=E4 available=false status=null
  geometry: row=6 column=18 name=E3 available=false status=null
  geometry: row=6 column=19 name=E2 available=false status=null
  geometry: row=6 column=20 name=E1 available=false status=null
  geometry: row=6 column=21 name= available=false status=null
  geometry: row=6 column=22 name= available=false status=null
  geometry: row=6 column=23 name= available=false status=null
  geometry: row=7 column=1 name= available=false status=null
  geometry: row=7 column=2 name= available=false status=null
  geometry: row=7 column=3 name=F18 available=false status=null
  geometry: row=7 column=4 name=F17 available=false status=null
  geometry: row=7 column=5 name=F16 available=false status=null
  geometry: row=7 column=6 name=F15 available=false status=null
  geometry: row=7 column=7 name=F14 available=false status=null
  geometry: row=7 column=8 name=F13 available=false status=null
  geometry: row=7 column=9 name=F12 available=false status=null
  geometry: row=7 column=10 name=F11 available=false status=null
  geometry: row=7 column=11 name=F10 available=false status=null
  geometry: row=7 column=12 name=F9 available=false status=null
  geometry: row=7 column=13 name=F8 available=false status=null
  geometry: row=7 column=14 name=F7 available=false status=null
  geometry: row=7 column=15 name=F6 available=false status=null
  geometry: row=7 column=16 name=F5 available=false status=null
  geometry: row=7 column=17 name=F4 available=false status=null
  geometry: row=7 column=18 name=F3 available=false status=null
  geometry: row=7 column=19 name=F2 available=true status=null
  geometry: row=7 column=20 name=F1 available=false status=null
  geometry: row=7 column=21 name= available=false status=null
  geometry: row=7 column=22 name= available=false status=null
  geometry: row=7 column=23 name= available=false status=null
  geometry: row=8 column=1 name=G23 available=false status=null
  geometry: row=8 column=2 name=G22 available=false status=null
  geometry: row=8 column=3 name=G21 available=false status=null
  geometry: row=8 column=4 name=G20 available=false status=null
  geometry: row=8 column=5 name=G19 available=false status=null
  geometry: row=8 column=6 name=G18 available=false status=null
  geometry: row=8 column=7 name=G17 available=false status=null
  geometry: row=8 column=8 name=G16 available=false status=null
  geometry: row=8 column=9 name=G15 available=false status=null
  geometry: row=8 column=10 name=G14 available=false status=null
  geometry: row=8 column=11 name=G13 available=false status=null
  geometry: row=8 column=12 name=G12 available=false status=null
  geometry: row=8 column=13 name=G11 available=false status=null
  geometry: row=8 column=14 name=G10 available=false status=null
  geometry: row=8 column=15 name=G9 available=false status=null
  geometry: row=8 column=16 name=G8 available=false status=null
  geometry: row=8 column=17 name=G7 available=false status=null
  geometry: row=8 column=18 name=G6 available=true status=null
  geometry: row=8 column=19 name=G5 available=true status=null
  geometry: row=8 column=20 name=G4 available=true status=null
  geometry: row=8 column=21 name=G3 available=true status=null
  geometry: row=8 column=22 name=G2 available=true status=null
  geometry: row=8 column=23 name=G1 available=true status=null
  geometry: row=9 column=1 name=H23 available=false status=null
  geometry: row=9 column=2 name=H22 available=false status=null
  geometry: row=9 column=3 name=H21 available=false status=null
  geometry: row=9 column=4 name=H20 available=false status=null
  geometry: row=9 column=5 name=H19 available=false status=null
  geometry: row=9 column=6 name=H18 available=false status=null
  geometry: row=9 column=7 name=H17 available=false status=null
  geometry: row=9 column=8 name=H16 available=false status=null
  geometry: row=9 column=9 name=H15 available=false status=null
  geometry: row=9 column=10 name=H14 available=false status=null
  geometry: row=9 column=11 name=H13 available=false status=null
  geometry: row=9 column=12 name=H12 available=false status=null
  geometry: row=9 column=13 name=H11 available=false status=null
  geometry: row=9 column=14 name=H10 available=false status=null
  geometry: row=9 column=15 name=H9 available=false status=null
  geometry: row=9 column=16 name=H8 available=false status=null
  geometry: row=9 column=17 name=H7 available=false status=null
  geometry: row=9 column=18 name=H6 available=false status=null
  geometry: row=9 column=19 name=H5 available=false status=null
  geometry: row=9 column=20 name=H4 available=false status=null
  geometry: row=9 column=21 name=H3 available=false status=null
  geometry: row=9 column=22 name=H2 available=false status=null
  geometry: row=9 column=23 name=H1 available=false status=null
  geometry: row=10 column=1 name=J22 available=true status=null
  geometry: row=10 column=2 name=J21 available=false status=null
  geometry: row=10 column=3 name=J20 available=false status=null
  geometry: row=10 column=4 name=J19 available=false status=null
  geometry: row=10 column=5 name=J18 available=false status=null
  geometry: row=10 column=6 name=J17 available=false status=null
  geometry: row=10 column=7 name=J16 available=false status=null
  geometry: row=10 column=8 name=J15 available=false status=null
  geometry: row=10 column=9 name=J14 available=false status=null
  geometry: row=10 column=10 name= available=false status=null
  geometry: row=10 column=11 name= available=false status=null
  geometry: row=10 column=12 name= available=false status=null
  geometry: row=10 column=13 name= available=false status=null
  geometry: row=10 column=14 name=J9 available=false status=null
  geometry: row=10 column=15 name=J8 available=false status=null
  geometry: row=10 column=16 name=J7 available=true status=null
  geometry: row=10 column=17 name= available=false status=null
  geometry: row=10 column=18 name=J6 available=true status=null
  geometry: row=10 column=19 name=J5 available=true status=null
  geometry: row=10 column=20 name=J4 available=false status=null
  geometry: row=10 column=21 name=J3 available=false status=null
  geometry: row=10 column=22 name=J2 available=false status=null
  geometry: row=10 column=23 name=J1 available=false status=null
  geometry: row=11 column=1 name=K6 available=false status=null
  geometry: row=11 column=2 name=K5 available=false status=null
  geometry: row=11 column=3 name=K4 available=false status=null
  geometry: row=11 column=4 name=K3 available=false status=null
  geometry: row=11 column=5 name=K2 available=false status=null
  geometry: row=11 column=6 name=K1 available=false status=null
  geometry: row=11 column=7 name= available=false status=null
  geometry: row=11 column=8 name= available=false status=null
  geometry: row=11 column=9 name= available=false status=null
  geometry: row=11 column=10 name= available=false status=null
  geometry: row=11 column=11 name= available=false status=null
  geometry: row=11 column=12 name= available=false status=null
  geometry: row=11 column=13 name= available=false status=null
  geometry: row=11 column=14 name= available=false status=null
  geometry: row=11 column=15 name= available=false status=null
  geometry: row=11 column=16 name= available=false status=null
  geometry: row=11 column=17 name= available=false status=null
  geometry: row=11 column=18 name= available=false status=null
  geometry: row=11 column=19 name= available=false status=null
  geometry: row=11 column=20 name= available=false status=null
  geometry: row=11 column=21 name= available=false status=null
  geometry: row=11 column=22 name= available=false status=null
  geometry: row=11 column=23 name= available=false status=null
Session ended. Aborted: false. Navigations spent: 3/3.
```
