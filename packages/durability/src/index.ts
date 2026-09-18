/**
 * Executable verification of ADR 0001 (docs/durability-harness-plan.md).
 *
 * The migrations under `migrations/` are the source of SQL truth for the durability
 * schema; `boundaries.ts` is the source of truth for the statement at each crash
 * boundary. The ADR cites this package by file + symbol rather than restating SQL, and
 * when the two disagree the code is right.
 */
export * from "./boundaries.js";
export * from "./expect-row.js";
export * from "./invariants.js";
export * from "./pool.js";
export {
  advanceCatalogueCrawlCursor,
  appendEvent,
  beginCatalogueCrawlPass,
  browseTheatres,
  browseTmdbSlate,
  completeCatalogueCrawlPass,
  completeTmdbPrewarm,
  countOpenSearches,
  createJobOutbox,
  createRunOutbox,
  createSearch,
  dispatchTmdbFetch,
  findTheatresWithinRadius,
  markOutboxPublished,
  markTmdbFetchDone,
  markTmdbFetchFailed,
  readCachedSchedule,
  readCatalogueCrawlState,
  readMovieById,
  readMoviesByNormalizedTitles,
  readRecheckOutcome,
  readScheduleRange,
  readTheatreById,
  readTmdbFetchById,
  readTmdbPrewarmState,
  runStatement,
  searchMoviesByTitle,
  searchTheatresByName,
  updatePerformanceProduct,
  upsertMovie,
  upsertSession,
  upsertTheatre,
  upsertTmdbMovie,
} from "./repository.js";
export type {
  AppendEventInput,
  CachedPerformance,
  CachedSchedule,
  CachedScheduleInput,
  CatalogueCrawlStateRow,
  CreateSearchInput,
  DispatchTmdbFetchInput,
  EventAppendedRow,
  MovieRow,
  MovieRowWithPoster,
  OutboxCreatedRow,
  OutboxPublishedRow,
  RecheckOutcomeRow,
  PerformanceProductUpdatedRow,
  ScheduleRange,
  ScheduleRangeDay,
  ScheduleRangeInput,
  ScheduleRangePerformance,
  SearchCreatedRow,
  SessionRow,
  TheatreRadiusInput,
  TheatreRadiusRow,
  TheatreRow,
  TheatreSlugs,
  TmdbFetchDispatchedRow,
  TmdbFetchRow,
  TmdbMovieRow,
  TmdbPrewarmStateRow,
  TmdbSlateRow,
  UpdatePerformanceProductInput,
  UpsertMovieInput,
  UpsertSessionInput,
  UpsertTheatreInput,
  UpsertTmdbMovieInput,
} from "./repository.js";
export * from "./lifecycle.js";
export * from "./redis.js";
export * from "./transactions.js";
export {
  SCHEMA_MIGRATION_TABLE,
  SchemaVersionError,
  MIGRATIONS,
  appliedMigrations,
  applyMigrations,
  baselineMigrations,
  migrationsDir,
  readMigrations,
  verifySchemaVersion,
} from "./migrate.js";
