import assert from "node:assert/strict";
import { stdout } from "node:process";

const durability = await import("@seatfirst/durability");

assert.deepEqual(
  [...durability.MIGRATIONS],
  [
    "001_schema.sql",
    "002_partitions.sql",
    "003_catalog.sql",
    "004_session.sql",
    "005_cost_ledger.sql",
    "006_retention.sql",
    "007_recheck_run_kind.sql",
    "008_cancelled_status.sql",
    "009_movie_catalog.sql",
    "010_catalogue_crawl_state.sql",
    "011_tmdb_movie.sql",
    "012_tmdb_fetch_outbox.sql",
    "013_recurring_window_search_admission.sql",
    "014_theatre_city.sql",
    "015_outbox_traceparent.sql",
    "016_provider_run_dispatch_rank.sql",
    "017_search_batch_deferred_count.sql",
    "018_search_continues_id.sql",
    "019_tmdb_movie_runtime_genre.sql",
    "020_performance_price_currency_basis.sql",
    "021_search_aggregate_evidence.sql",
    "022_retention_least_privilege.sql",
    "023_restore_sentinel.sql",
    "024_retire_restore_sentinel.sql",
    "025_tmdb_movie_slate_release.sql",
    "026_diagnostic_capture.sql",
    "027_amc_movie_catalogue.sql",
    "028_movie_schedule_resolution.sql",
    "029_theatre_amenities.sql",
  ],
);

const migrations = await durability.readMigrations();
assert.deepEqual(
  migrations.map((migration) => migration.name),
  [...durability.MIGRATIONS],
);
assert.match(
  migrations.find((migration) => migration.name === "003_catalog.sql")?.sql ?? "",
  /CREATE TABLE theatre/,
);

assert.equal(typeof durability.upsertTheatre, "function");
assert.equal(typeof durability.upsertMovie, "function");
assert.equal(typeof durability.readMovieById, "function");
assert.equal(typeof durability.upsertTmdbMovie, "function");
assert.equal(typeof durability.readCatalogueCrawlState, "function");
assert.equal(typeof durability.beginCatalogueCrawlPass, "function");
assert.equal(typeof durability.advanceCatalogueCrawlCursor, "function");
assert.equal(typeof durability.completeCatalogueCrawlPass, "function");
assert.equal(typeof durability.dispatchTmdbFetch, "function");
assert.equal(typeof durability.readTmdbFetchById, "function");
assert.equal(typeof durability.markTmdbFetchDone, "function");
assert.equal(typeof durability.markTmdbFetchFailed, "function");
assert.equal(typeof durability.readAmcMovieCatalogueState, "function");
assert.equal(typeof durability.completeAmcMovieCatalogueCrawl, "function");
assert.equal(typeof durability.upsertAmcMovieCatalogue, "function");
assert.equal(typeof durability.browseAmcMovieCatalogue, "function");
assert.equal(typeof durability.markOutboxPublished, "function");
// The generic executor is a public escape hatch (B1): a caller needing one of the 22
// boundary families with no named wrapper must be able to reach it through the built
// package's own export surface, not just the source tree.
assert.equal(typeof durability.runStatement, "function");

stdout.write(`built package loaded ${migrations.length} migrations through its public export\n`);
