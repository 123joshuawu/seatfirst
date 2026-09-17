/**
 * Server-only Playwright/Chrome transport for the AMC corridor — task P6
 * (`docs/tasks/P6-browser-runtime-transport/spec.md`), authorized by ADR 0004
 * (`docs/adr/0004-deployment-shape-egress-identity.md`, approved) and ADR 0005 §B/§D
 * (`docs/adr/0005-security-privacy-operations.md`, approved).
 *
 * P6 reports typed navigation outcomes; it calls no durability transition (S8 maps them).
 * All numeric bounds are injected caller-supplied parameters with no default (P6.18).
 */
export * from "./guard.js";
export * from "./outcome.js";
export * from "./observability.js";
export * from "./readiness-server.js";
export * from "./supervisor.js";
export * from "./transport.js";
