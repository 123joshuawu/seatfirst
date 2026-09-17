import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

import { applyMigrations } from "../../src/migrate.js";

/**
 * Postgres 16 — the version ADR 0001 §1 names and §8 targets. Pinned by digest-free tag
 * on purpose: the point is to match the deployment target, not to freeze a build.
 */
const PG_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

/** Applied once; every test clones it (`CREATE DATABASE … TEMPLATE`), so resets are milliseconds. */
export const TEMPLATE_DB = "durability_base";

declare module "vitest" {
  interface ProvidedContext {
    /** Admin connection string, pointing at the container's default database. */
    adminUrl: string;
    templateDb: string;
    /** Present in the extended tiers 4–6 run; only tiers 4–5 exercise Redis. */
    redisUrl: string;
    /** Defense in depth: RedisClient refuses FLUSHALL unless global setup grants this. */
    redisFlushAllAllowed: boolean;
  }
}

let container: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  // A pre-provisioned server (CI service container, local instance) skips testcontainers
  // entirely; the harness only needs a superuser URL it can CREATE DATABASE against.
  let adminUrl = process.env["DURABILITY_PG_URL"];

  if (!adminUrl) {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    adminUrl = container.getConnectionUri();
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Migration 022 GRANTs EXECUTE to retention_worker, so the role must exist before
    // any migration runs — including the fresh empty-DB apply in tier 0. Test-only and
    // credential-free (NOLOGIN): tier 0 exercises the boundary via SET ROLE, never a
    // worker login. Idempotent for persistent servers (roles are cluster-global).
    await admin.query(`
      DO $retention_worker$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker') THEN
          CREATE ROLE retention_worker WITH NOLOGIN;
        END IF;
      END
      $retention_worker$;
    `);
    // Rebuilt every run: the template must reflect the migrations as they are now, not as
    // they were when someone last ran the suite against a persistent server.
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    // Migration 023 REVOKES on restore_sentinel FROM seatfirst_app, so that role must
    // exist before any migration runs, exactly like retention_worker above. Placed
    // after CREATE DATABASE (rather than beside the worker block) so the
    // `global-setup.ts:54-61` range cited by src/migrate.ts keeps pointing at the
    // worker creation it describes. Test-only and credential-free (NOLOGIN).
    await admin.query(`
      DO $seatfirst_app$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seatfirst_app') THEN
          CREATE ROLE seatfirst_app WITH NOLOGIN;
        END IF;
      END
      $seatfirst_app$;
    `);
  } finally {
    await admin.end();
  }

  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  const template = new Client({ connectionString: templateUrl.toString() });
  await template.connect();
  // Replicate 14-app-role.sh's blanket DML default on the template DB itself (default
  // privileges are database-scoped, so the maintenance DB cannot carry them here).
  // Tables created below by applyMigrations then auto-grant DML to seatfirst_app,
  // exactly as on a provisioned host — which is what makes 023's trailing REVOKE on
  // restore_sentinel load-bearing in tests rather than vacuous.
  await template.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seatfirst_app;
  `);
  try {
    await applyMigrations(template);
  } finally {
    await template.end();
  }

  project.provide("adminUrl", adminUrl);
  project.provide("templateDb", TEMPLATE_DB);

  if (process.env["DURABILITY_REDIS_REQUIRED"] === "1") {
    let redisUrl = process.env["DURABILITY_REDIS_URL"];
    const usesExternalRedis = Boolean(redisUrl);
    if (usesExternalRedis && process.env["DURABILITY_REDIS_ALLOW_FLUSHALL"] !== "1") {
      throw new Error(
        "DURABILITY_REDIS_URL must name a disposable Redis server: extended tiers 4–6 " +
          "include tiers 4–5, which exercise full-loss recovery with FLUSHALL. Set " +
          "DURABILITY_REDIS_ALLOW_FLUSHALL=1 only " +
          "after verifying that the entire server may be erased.",
      );
    }
    if (!usesExternalRedis) {
      redisContainer = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
        .start();
      redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    }
    if (!redisUrl) throw new Error("Redis was required but no connection URL was resolved");
    project.provide("redisUrl", redisUrl);
    project.provide("redisFlushAllAllowed", true);
  }
}

export async function teardown(): Promise<void> {
  await Promise.all([container?.stop(), redisContainer?.stop()]);
}
