/**
 * Guarded accessors for PostgreSQL result rows (S40). Every DB-row → domain-shape
 * boundary in the server's read paths reads its columns through these instead of an
 * unchecked `row["x"] as T` cast, so a drifted migration or a renamed column fails
 * loudly at the query boundary — with a `TypeError` naming the offending column and
 * the received runtime kind — instead of flowing silently into dispatch decisions,
 * aggregate assembly, SSE catch-up cursor math, or route output.
 *
 * Pure functions over `Record<string, unknown>`: directly unit-testable with no
 * database (`test/pg-row.test.ts`). Deliberately hand-written rather than Zod schemas:
 * durability row shapes have no schema home by design (`packages/durability` adds no
 * validation framework), and these four primitives are the whole contract.
 */

/** One pg result row: whatever the driver handed back, read strictly column-by-column. */
type Row = Record<string, unknown>;

/** Human-readable runtime kind of a received value, used verbatim in error messages. */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Buffer.isBuffer(value)) return "Buffer";
  if (value instanceof Date) return "Date";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}

function typeError(column: string, expected: string, value: unknown): TypeError {
  return new TypeError(
    `pg row column "${column}": expected ${expected}, received ${describeKind(value)}`,
  );
}

/**
 * Reads a required text column — `text`, or pg's decimal-string delivery of `bigint`
 * (no int8 parser is registered anywhere in this repo, so revisions/epochs/seqs are
 * strings at runtime and are guarded as such).
 */
export function rowString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw typeError(column, "string", value);
  return value;
}

/**
 * Reads a nullable text column: SQL `NULL` — or a missing key's `undefined` — maps to
 * `null`; a present non-string fails loudly.
 */
export function rowNullableString(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw typeError(column, "string | null", value);
  return value;
}

/**
 * Reads a required integer column (pg `integer`, including `::integer` results).
 * Numeric strings are rejected on purpose: a quoted number means a `bigint` column fed
 * a field typed as a number — exactly the migration drift this guard exists to surface.
 */
export function rowNumber(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number") throw typeError(column, "number", value);
  return value;
}

/** Reads a required `bytea` column, which pg delivers as a `Buffer`. */
export function rowBuffer(row: Row, column: string): Buffer {
  const value = row[column];
  if (!Buffer.isBuffer(value)) throw typeError(column, "Buffer", value);
  return value;
}
