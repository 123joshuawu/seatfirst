/**
 * Executable verification of ADR 0001 (docs/durability-harness-plan.md).
 *
 * The migrations under `migrations/` are the source of SQL truth for the durability
 * schema; `boundaries.ts` is the source of truth for the statement at each crash
 * boundary. The ADR cites this package by file + symbol rather than restating SQL, and
 * when the two disagree the code is right.
 */
export * from "./boundaries.js";
export * from "./blob-store.js";
export * from "./expect-row.js";
export * from "./invariants.js";
export * from "./pool.js";
export {
  advanceCatalogueCrawlCursor,
  appendEvent,
  beginCatalogueCrawlPass,
  browseAmcMovieCatalogue,
  browseTheatres,
  completeAmcMovieCatalogueCrawl,
  completeCatalogueCrawlPass,
  countOpenSearches,
  createJobOutbox,
  createRunOutbox,
  createSearch,
  dispatchTmdbFetch,
  findTheatresWithinRadius,
  insertDiagnosticCapture,
  sweepExpiredDiagnosticCaptures,
  markOutboxPublished,
  markTmdbFetchDone,
  markTmdbFetchFailed,
  readAmcMovieCatalogueState,
  readAmcMovieCatalogueByNormalizedTitles,
  readCachedSchedule,
  readCatalogueCrawlState,
  readMovieById,
  readMoviesByNormalizedTitles,
  readRecheckOutcome,
  readScheduleRange,
  readTheatreById,
  readTmdbFetchById,
  runStatement,
  searchMoviesByTitle,
  searchTheatresByName,
  updatePerformanceProduct,
  upsertAmcMovieCatalogue,
  upsertMovie,
  upsertSession,
  upsertTheatre,
  upsertTmdbMovie,
} from "./repository.js";
export type {
  AmcMovieCatalogueRow,
  AmcMovieCatalogueSlateRow,
  AmcMovieCatalogueStateRow,
  AmcMovieCatalogueTitleRow,
  AppendEventInput,
  CachedPerformance,
  CachedSchedule,
  CachedScheduleInput,
  CatalogueCrawlStateRow,
  CreateSearchInput,
  DiagnosticCaptureOutcomeKind,
  DiagnosticCaptureRow,
  DiagnosticCaptureSweptRow,
  DispatchTmdbFetchInput,
  EventAppendedRow,
  InsertDiagnosticCaptureInput,
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
  UpdatePerformanceProductInput,
  UpsertAmcMovieCatalogueInput,
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
