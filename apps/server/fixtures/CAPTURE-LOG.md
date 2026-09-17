# Fixture Capture Log (browser transport)

**Notice**: The second authorized live session (ADR 0002 §3.4, "Second-session operator
delegation and Chrome-corridor authorization," 2026-08-13) ran through P7's Chrome corridor
(`apps/server/scripts/capture-fixtures-browser.ts`), not P3's plain-fetch script. The first
scripted attempt aborted before spending any budget because the initially chosen
`AMC_USER_AGENT` failed `packages/providers/src/amc/identity.ts`'s anti-spoofing check; the
corrected honest, non-browser-spoofing user agent then succeeded on all 27 preregistered
navigations. See both session blocks below and ADR 0002 §3.4's "Outcome" note.

```text
## Session started at 2026-08-13T05:02:56.251Z
Operator: Claude (coding agent), delegated by Josh Wu 2026-08-13
Target: https://www.amctheatres.com/movies
Target: https://www.amctheatres.com/movie-theatres?q=San+Francisco%2C+CA
Target: https://www.amctheatres.com/movie-theatres?q=Chicago%2C+IL
Target: https://www.amctheatres.com/movie-theatres?q=Atlanta%2C+GA
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-sunnyvale-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-newpark-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-kabuki-8/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-manteca-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-evanston-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-randhurst-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-norridge-6/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-north-dekalb-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-phipps-plaza-14/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-southlake-24/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/showtimes/145738252/seats
Target: https://www.amctheatres.com/showtimes/144251358/seats
Target: https://www.amctheatres.com/showtimes/145738053/seats
Target: https://www.amctheatres.com/showtimes/145381450/seats
Target: https://www.amctheatres.com/showtimes/145817558/seats
Target: https://www.amctheatres.com/showtimes/144239197/seats
Target: https://www.amctheatres.com/showtimes/146131401/seats
Target: https://www.amctheatres.com/showtimes/145835334/seats
Target: https://www.amctheatres.com/showtimes/145835344/seats
Target: https://www.amctheatres.com/showtimes/145835357/seats
Target: https://www.amctheatres.com/showtimes/0/seats
Route mix: 1 movies, 3 theatres, 12 showtimes, 11 seats
[ABORT] Fatal error encountered.
Session ended. Aborted: true. Navigations spent: 0/30.
```

```text
## Session started at 2026-08-13T05:04:05.492Z
Operator: Claude (coding agent), delegated by Josh Wu 2026-08-13
Target: https://www.amctheatres.com/movies
Target: https://www.amctheatres.com/movie-theatres?q=San+Francisco%2C+CA
Target: https://www.amctheatres.com/movie-theatres?q=Chicago%2C+IL
Target: https://www.amctheatres.com/movie-theatres?q=Atlanta%2C+GA
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-sunnyvale-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-newpark-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-kabuki-8/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/san-francisco/amc-manteca-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-evanston-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-randhurst-12/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/chicago/amc-norridge-6/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-north-dekalb-16/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-phipps-plaza-14/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/atlanta/amc-southlake-24/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/showtimes/145738252/seats
Target: https://www.amctheatres.com/showtimes/144251358/seats
Target: https://www.amctheatres.com/showtimes/145738053/seats
Target: https://www.amctheatres.com/showtimes/145381450/seats
Target: https://www.amctheatres.com/showtimes/145817558/seats
Target: https://www.amctheatres.com/showtimes/144239197/seats
Target: https://www.amctheatres.com/showtimes/146131401/seats
Target: https://www.amctheatres.com/showtimes/145835334/seats
Target: https://www.amctheatres.com/showtimes/145835344/seats
Target: https://www.amctheatres.com/showtimes/145835357/seats
Target: https://www.amctheatres.com/showtimes/0/seats
Route mix: 1 movies, 3 theatres, 12 showtimes, 11 seats
[ATTEMPT] 2026-08-13T05:04:07.635Z | https://www.amctheatres.com/movies | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 54
[ATTEMPT] 2026-08-13T05:04:08.800Z | https://www.amctheatres.com/movie-theatres?q=San+Francisco%2C+CA | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-13T05:04:10.432Z | https://www.amctheatres.com/movie-theatres?q=Chicago%2C+IL | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-13T05:04:11.819Z | https://www.amctheatres.com/movie-theatres?q=Atlanta%2C+GA | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-13T05:04:13.585Z | https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:15.813Z | https://www.amctheatres.com/movie-theatres/san-francisco/amc-sunnyvale-12/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:17.578Z | https://www.amctheatres.com/movie-theatres/san-francisco/amc-newpark-12/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:19.441Z | https://www.amctheatres.com/movie-theatres/san-francisco/amc-kabuki-8/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:21.908Z | https://www.amctheatres.com/movie-theatres/san-francisco/amc-manteca-16/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:24.217Z | https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:26.895Z | https://www.amctheatres.com/movie-theatres/chicago/amc-evanston-12/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 44
[ATTEMPT] 2026-08-13T05:04:29.102Z | https://www.amctheatres.com/movie-theatres/chicago/amc-randhurst-12/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:31.314Z | https://www.amctheatres.com/movie-theatres/chicago/amc-norridge-6/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:33.785Z | https://www.amctheatres.com/movie-theatres/atlanta/amc-north-dekalb-16/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 44
[ATTEMPT] 2026-08-13T05:04:35.726Z | https://www.amctheatres.com/movie-theatres/atlanta/amc-phipps-plaza-14/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:38.109Z | https://www.amctheatres.com/movie-theatres/atlanta/amc-southlake-24/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T05:04:41.182Z | https://www.amctheatres.com/showtimes/145738252/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:43.325Z | https://www.amctheatres.com/showtimes/144251358/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:45.200Z | https://www.amctheatres.com/showtimes/145738053/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:47.267Z | https://www.amctheatres.com/showtimes/145381450/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:49.232Z | https://www.amctheatres.com/showtimes/145817558/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:51.494Z | https://www.amctheatres.com/showtimes/144239197/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:53.574Z | https://www.amctheatres.com/showtimes/146131401/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:54.750Z | https://www.amctheatres.com/showtimes/145835334/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:56.727Z | https://www.amctheatres.com/showtimes/145835344/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:58.622Z | https://www.amctheatres.com/showtimes/145835357/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 47
[ATTEMPT] 2026-08-13T05:04:59.558Z | https://www.amctheatres.com/showtimes/0/seats | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 46
Session ended. Aborted: false. Navigations spent: 27/30.
```

```text
## Session started at 2026-08-13T18:56:02.735Z
Operator: Claude (coding agent), delegated by Josh Wu 2026-08-13, third session
Target: https://www.amctheatres.com/movie-theatres?q=New+York%2C+NY
Target: https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes?date=2026-08-13
Target: https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes?date=2026-08-13
Route mix: 0 movies, 1 theatres, 2 showtimes, 0 seats
[ATTEMPT] 2026-08-13T18:56:05.069Z | https://www.amctheatres.com/movie-theatres?q=New+York%2C+NY | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-13T18:56:07.826Z | https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
[ATTEMPT] 2026-08-13T18:56:10.432Z | https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes?date=2026-08-13 | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 49
Session ended. Aborted: false. Navigations spent: 3/5.
```

```text
## Session started at 2026-08-15T23:35:03.351Z
Operator: Claude (coding agent), delegated by Josh Wu 2026-08-15, fifth session
Target: https://www.amctheatres.com/movie-theatres
Target: https://www.amctheatres.com/movie-theatres/atlanta
Target: https://www.amctheatres.com/movie-theatres/san-francisco
Route mix: 0 movies, 3 theatres, 0 showtimes, 0 seats
[ATTEMPT] 2026-08-15T23:35:06.051Z | https://www.amctheatres.com/movie-theatres | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-15T23:35:07.401Z | https://www.amctheatres.com/movie-theatres/atlanta | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
[ATTEMPT] 2026-08-15T23:35:08.677Z | https://www.amctheatres.com/movie-theatres/san-francisco | outcome=SUCCESS
  hop 1/4: AMC_INITIAL | status=302
  hop 2/4: QUEUE_ENTRY | status=302
  hop 3/4: AMC_TOKEN_RETURN | status=302
  hop 4/4: AMC_CLEAN_RETURN | status=200
  subresourceAborts: 43
Session ended. Aborted: false. Navigations spent: 3/5.
```
