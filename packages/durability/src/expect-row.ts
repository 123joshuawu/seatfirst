import type { Statement } from "./boundaries.js";

/** Returns the first fetched row, or explains the boundary's caller-visible loser path. */
export function expectRow<Row>(statement: Statement, rows: readonly Row[]): Row {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `${statement.name} (${statement.boundary}) returned 0 rows. ` +
        `0 rows means: ${statement.zeroRowsMeans || "(no defined loser path)"}`,
    );
  }
  return row;
}
