import type { FormatPref } from "@/types/placement";

export interface FormatMeta {
  v: Exclude<FormatPref, "any">;
  label: string;
}

export const FORMAT_META: FormatMeta[] = [
  { v: "imax", label: "IMAX" },
  { v: "dolby", label: "Dolby Cinema" },
  { v: "standard", label: "Standard" },
];

/** Matches the fixture auditorium's real row count (`DEV_GRID_ROWS` in `fixtures/contracts.ts`): the handoff grid loop must cover every row a placement can reference (default fixture placement sits on row 5). */
export const GRID_ROWS = 8;
export const GRID_COLS = 9;
