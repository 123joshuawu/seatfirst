/**
 * Shared viewport breakpoints (ADR 0068). `mobile` is the single width
 * threshold below which search surfaces render as bottom sheets instead of
 * inline popovers — the same 680px the search view models and the legacy
 * autocomplete shell already used as a local const.
 */
export const breakpoints = { mobile: 680 } as const;
