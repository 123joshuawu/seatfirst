// P1 landed the `VenueProvider` contract (types, Zod schemas, normalized error enum). Gate 1
// (ADR 0002, `docs/adr/0002-legal-data-use.md`) remains `proposed` overall (GDPR/CCPA items
// #3/#4 still open), but its two items gating fixture capture — §2.1 (Terms of Use) and §2.2
// (robots.txt) — resolved 2026-08-08, which authorizes the bounded fixture-capture session
// (§3.4) and the adapter-implementation work depending on it (`docs/gates.md` "Live upstream
// traffic"). P4 lands that adapter machinery (offline-tested, no live request). P3 lands the
// capture script itself; the one authorized live session is explicitly human-authorized and separate.
export * from "./contract.js";
export * from "./errors.js";
export * from "./amc/identity.js";
export * from "./amc/routes.js";
export * from "./amc/classify.js";
export * from "./amc/redact.js";
export * from "./amc/capture-redact.js";
export * from "./amc/fetcher.js";
export * from "./amc/provider.js";
export * from "./amc/postal-timezone.js";
export * from "./amc/parse/market-slugs.js";
export * from "./amc/parse/theatres.js";
export * from "./amc/parse/seats.js";
export * from "./amc/parse/showtimes.js";
export * from "./dev-fixtures/showtime-id.js";
