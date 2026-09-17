import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

const run = promisify(execFile);

/**
 * migrate-cli is not part of the package's public exports (its own header comment): it
 * only ever runs as a compiled CLI (`node dist/src/migrate-cli.js` — the one-shot
 * `migrate` service in docker-compose.dev.yml). So it is tested exactly as deployed —
 * spawned as a real child process against a fresh empty database — never imported.
 * `dist/` exists because the package's `pretest` script builds before vitest runs.
 */

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "migrate-cli.js");

const empties: string[] = [];

afterAll(async () => {
  if (empties.length === 0) return;
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  for (const name of empties) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

/** Fresh empty database per test (tier0's pattern), returning its connection URL. */
async function createEmptyDatabase(): Promise<string> {
  const admin = new Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  const name = `cli_${process.pid}_${empties.length}`;
  empties.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(inject("adminUrl"));
  url.pathname = `/${name}`;
  return url.toString();
}

describe("migrate-cli", () => {
  it("applies every migration to an empty database and exits clean", async () => {
    const url = await createEmptyDatabase();
    const { stdout } = await run(process.execPath, [cli], {
      env: { ...process.env, DATABASE_URL: url },
    });
    expect(stdout).toContain("migrations applied");

    // The CLI said it worked; prove the schema actually landed (tier0's pg_class query,
    // narrowed to one core table from 003_catalog.sql).
    const db = new Client({ connectionString: url });
    await db.connect();
    try {
      const { rows } = await db.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = 'theatre'`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await db.end();
    }
  });

  it("refuses to run without DATABASE_URL (exit 64, stderr only)", async () => {
    const withoutDbUrl = { ...process.env };
    delete withoutDbUrl.DATABASE_URL;
    // Promisified execFile rejects on non-zero exit; the rejection carries code/stdout/stderr.
    await expect(run(process.execPath, [cli], { env: withoutDbUrl })).rejects.toMatchObject({
      code: 64,
      stdout: "",
      stderr: expect.stringContaining("DATABASE_URL is required"),
    });
  });
});
