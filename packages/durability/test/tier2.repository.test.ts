import { Client, type Pool } from "pg";
import { describe, expect, expectTypeOf, inject, it } from "vitest";

import * as B from "../src/boundaries.js";
import { expectRow } from "../src/expect-row.js";
import { MIGRATIONS } from "../src/migrate.js";
import { createPool, migrate, poolClient, withTransaction } from "../src/pool.js";
import {
  appendEvent,
  createSearch as createSearchRow,
  findTheatresWithinRadius,
  markOutboxPublished,
  runStatement,
  updatePerformanceProduct,
  upsertTheatre,
} from "../src/repository.js";
import type {
  EventAppendedRow,
  OutboxPublishedRow,
  PerformanceProductUpdatedRow,
  SearchCreatedRow,
  TheatreRadiusRow,
  TheatreRow,
} from "../src/repository.js";
import { acceptFetch } from "../src/transactions.js";
import type { SqlClient } from "../src/transactions.js";

import { useDatabase } from "./support/pg.js";

describe("tier 2 — production pool and statement repository", () => {
  const db = useDatabase();

  const poolForTest = () =>
    createPool({
      connectionString: db().url,
      max: 2,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 1_000,
    });

  const createInput = () => ({
    searchId: "srch_repository",
    sessionId: "sess_repository",
    idempotencyKey: "idem_repository",
    spec: { v: 1 },
    specHash: "hash_repository",
    deadlineAt: new Date(Date.now() + 60_000),
  });

  it("rolls back a thrown transaction body and commits the same write on success", async () => {
    const pool = poolForTest();
    try {
      const marker = new Error("abort repository transaction");
      await expect(
        withTransaction(pool, async (transaction) => {
          expect(await createSearchRow(transaction, createInput())).toEqual([
            { search_id: "srch_repository" },
          ]);
          throw marker;
        }),
      ).rejects.toBe(marker);

      const afterRollback = await db().connect();
      try {
        expect(
          (
            await afterRollback.query(`SELECT search_id FROM search WHERE search_id = $1`, [
              "srch_repository",
            ])
          ).rows,
        ).toEqual([]);
      } finally {
        await afterRollback.end();
      }

      await expect(
        withTransaction(pool, (transaction) => createSearchRow(transaction, createInput())),
      ).resolves.toEqual([{ search_id: "srch_repository" }]);

      const afterCommit = await db().connect();
      try {
        expect(
          (
            await afterCommit.query(`SELECT search_id FROM search WHERE search_id = $1`, [
              "srch_repository",
            ])
          ).rows,
        ).toEqual([{ search_id: "srch_repository" }]);
      } finally {
        await afterCommit.end();
      }
    } finally {
      await pool.end();
    }
  });

  it("makes a single autocommitted repository call without a caller-managed transaction (N1)", async () => {
    // `poolClient(pool)` adapts a bare `Pool` into exactly the `SqlClient` a repository
    // function expects, for a single autocommitted call outside `withTransaction`.
    //
    // NOTE: passing the bare `Pool` itself to a repository function (e.g.
    // `createSearch(pool, …)`) is NOT actually rejected by the type checker, despite an
    // earlier version of this comment claiming otherwise — verified with a `@ts-expect-error`
    // here that came back "Unused '@ts-expect-error' directive" (TS2578), i.e. the call
    // type-checks. The culprit is `Pool.query`'s first overload,
    // `query<T extends Submittable>(queryStream: T): T`: TypeScript compares a source with
    // *multiple* call signatures against a target by erasing each signature's type
    // parameters, so this one reduces to `(queryStream: any) => any` — which is assignable
    // to any target `query` with at least one parameter, e.g.
    // `query(text: string, values?: readonly unknown[]): boolean`, an otherwise-unrelated
    // shape. So this line documents a convention, not a compiler-enforced one; unlike the
    // five `BEGIN`-emitting functions in `transactions.ts`, which get real compile-time
    // enforcement via `TransactionClient`'s nominal brand (`src/transactions.ts`) — brand
    // checking is just property presence, which structural comparison polices reliably.
    expectTypeOf(poolClient).returns.toEqualTypeOf<SqlClient>();

    const pool = poolForTest();
    try {
      const client = poolClient(pool);
      await expect(createSearchRow(client, createInput())).resolves.toEqual([
        { search_id: "srch_repository" },
      ]);

      const verify = await db().connect();
      try {
        expect(
          (
            await verify.query(`SELECT search_id FROM search WHERE search_id = $1`, [
              "srch_repository",
            ])
          ).rows,
        ).toEqual([{ search_id: "srch_repository" }]);
      } finally {
        await verify.end();
      }
    } finally {
      await pool.end();
    }
  });

  it("rejects a pooled client at the type level for the five BEGIN-emitting functions (N1)", () => {
    // Type-only: `typeOnlyPoolRejectedByAcceptFetch` is declared but never called (the `void`
    // below only references it), so nothing here opens a connection or touches the database —
    // only the function body is type-checked, and `@ts-expect-error` itself fails to compile
    // if this stops being an error. This is the live proof that Fix 1's brand actually blocks
    // what the doc comments only used to warn about: `poolClient(pool)` (plain `SqlClient`) may
    // issue each call on a different physical connection, so passing it to any of the five
    // `BEGIN`-emitting functions in `transactions.ts` (`acceptFetch`/`failRun`/`terminalize`/
    // `sweepFailExhaustedJobs`/`sweepFailExhaustedRuns`) must not compile.
    function typeOnlyPoolRejectedByAcceptFetch(pool: Pool): void {
      // @ts-expect-error — poolClient(pool) is plain SqlClient, not TransactionClient.
      void acceptFetch(poolClient(pool), { runId: "run_never_used", generation: 1 });
    }
    void typeOnlyPoolRejectedByAcceptFetch;
  });

  it("rejects a parameter-count mismatch before issuing the statement", async () => {
    let queryCalls = 0;
    const countedClient: SqlClient = {
      async query(text, values) {
        queryCalls += 1;
        return db().query(text, values);
      },
    };

    await expect(
      runStatement(countedClient, B.B1_CREATE_SEARCH, [
        "srch_repository",
        "sess_repository",
        "idem_repository",
        JSON.stringify({ v: 1 }),
        "hash_repository",
      ]),
    ).rejects.toThrow("B1_CREATE_SEARCH expects 6 parameters");
    expect(queryCalls).toBe(0);
    expect((await db().query(`SELECT search_id FROM search`)).rows).toEqual([]);
  });

  it("expectRow reports the statement's own zero-row meaning", () => {
    expect(() => expectRow(B.B1_CREATE_SEARCH, [])).toThrow(B.B1_CREATE_SEARCH.zeroRowsMeans);
    expect(expectRow(B.OUTBOX_MARK_PUBLISHED, [{ state: "PUBLISHED" }])).toEqual({
      state: "PUBLISHED",
    });
  });

  it("publishes narrow non-generic repository signatures", () => {
    expectTypeOf(createSearchRow).returns.toEqualTypeOf<Promise<SearchCreatedRow[]>>();
    expectTypeOf(markOutboxPublished).parameter(1).toEqualTypeOf<string>();
    expectTypeOf(markOutboxPublished).returns.toEqualTypeOf<Promise<OutboxPublishedRow[]>>();
    expectTypeOf(upsertTheatre).returns.toEqualTypeOf<Promise<TheatreRow[]>>();
    expectTypeOf(findTheatresWithinRadius).returns.toEqualTypeOf<Promise<TheatreRadiusRow[]>>();
    expectTypeOf(updatePerformanceProduct).returns.toEqualTypeOf<
      Promise<PerformanceProductUpdatedRow[]>
    >();
    expectTypeOf(appendEvent).returns.toEqualTypeOf<Promise<EventAppendedRow[]>>();
  });

  it("applies the registered migrations through one checked-out pool connection", async () => {
    const databaseName = `repository_migrate_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: inject("adminUrl") });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);

    const url = new URL(inject("adminUrl"));
    url.pathname = `/${databaseName}`;
    const pool = createPool({
      connectionString: url.toString(),
      max: 2,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 1_000,
    });
    try {
      // `migrate(pool)` checks out one connection (advisory lock is session-scoped,
      // `src/migrate.ts` / `src/pool.ts:110-133`) and returns the names applied in
      // `MIGRATIONS` order — on a fresh empty database that is the full list.
      await expect(migrate(pool)).resolves.toEqual([...MIGRATIONS]);
      expect(
        (await pool.query(`SELECT to_regclass('public.theatre')::text AS theatre`)).rows,
      ).toEqual([{ theatre: "theatre" }]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });
});
