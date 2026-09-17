/**
 * Thin API binding for `showtimes.recheck`.
 * Spec UI6.1 — mirrors apps/mobile-web/src/api/search.ts pattern.
 */
import type { RecheckInput, RecheckResult } from "@seatfirst/core";
import { trpcClient } from "@/lib/trpc";

/**
 * Call `showtimes.recheck` with the exact 4-field RecheckInput.
 */
export async function recheckShowtime(input: RecheckInput): Promise<RecheckResult> {
  return trpcClient.showtimes.recheck.mutate(input);
}
