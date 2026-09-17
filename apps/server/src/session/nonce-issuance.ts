import type { RankedAnswer, Recommendation, ResultGroup, ShowtimeOffer } from "@seatfirst/core";

import { RECHECK_NONCE_TTL_MS, signRecheckNonce } from "./nonce.js";

/**
 * S34.3 / ADR 0017 — the production issuance path for recheck nonces.
 *
 * The terminal answer is persisted with a `nonce: null` placeholder on every offer
 * (`toShowtimeOffer`), because a nonce's 10-minute expiry must start when a client
 * actually receives the answer — not when the answer was assembled. This module walks a
 * served ranked answer and, for each recommendation, signs one single-use nonce per offer,
 * binding the recommendation's `placement.placementKey` and the offer's `showtimeId`
 * (`docs/seatfirst-architecture.md:397`). It is the issuer `session/nonce.ts` names as
 * "the answer-assembly layer's job" (S22's deferred task), and it consumes the SAME
 * `signRecheckNonce` primitive `showtimes.recheck`'s verifier consumes — issuance and
 * verification cannot drift on shape or serialization.
 */

/** The per-serve issuance inputs. Every field is injected — no default (gate 14). */
export interface RecheckNonceIssuance {
  readonly sessionId: string;
  readonly searchId: string;
  readonly resultVersion: number;
  readonly nonceSecret: string;
  /** A fresh ULID mint (the repo's generic `mintSessionId`, S16.11). */
  readonly mintId: () => string;
  /** Epoch-millisecond clock; a nonce's 10-minute expiry starts at issuance. */
  readonly now: () => number;
}

function issueOffer(
  offer: ShowtimeOffer,
  placementKey: string,
  issuance: RecheckNonceIssuance,
): ShowtimeOffer {
  return {
    ...offer,
    nonce: signRecheckNonce(
      {
        id: issuance.mintId(),
        sessionId: issuance.sessionId,
        searchId: issuance.searchId,
        resultVersion: issuance.resultVersion,
        showtimeId: offer.showtimeId,
        placementKey,
        expiry: issuance.now() + RECHECK_NONCE_TTL_MS,
      },
      issuance.nonceSecret,
    ),
  };
}

function issueRecommendation<T extends Recommendation>(
  recommendation: T,
  issuance: RecheckNonceIssuance,
): T {
  const placementKey = recommendation.placement.placementKey;
  return {
    ...recommendation,
    showtimes: recommendation.showtimes.map((offer) => issueOffer(offer, placementKey, issuance)),
    // Sound: the only mutation is each offer's `nonce` (null → signed token); the
    // recommendation's `placement`/`reasons`/`relaxed` are preserved verbatim.
  };
}

/**
 * Sign one single-use recheck nonce per offer across a ranked answer. CONFIDENT injects
 * `primary`; HEDGED injects every `alternatives` entry; EMPTY carries no offers and is
 * returned unchanged. The transformation only fills each offer's `nonce` — every other
 * field is preserved verbatim, so rank and answer stability (ADR 0012) are untouched.
 */
export function issueRecheckNonces(
  answer: RankedAnswer,
  issuance: RecheckNonceIssuance,
): RankedAnswer {
  switch (answer.mode) {
    case "CONFIDENT":
      return { ...answer, primary: issueRecommendation(answer.primary, issuance) };
    case "HEDGED":
      return {
        ...answer,
        // `.map` widens the 2- or 3-tuple to `HedgedRecommendation[]`; length and each
        // element are structurally preserved (only `nonce` changes), so the tuple cast is
        // sound. This is the one narrow cast the walker requires.
        alternatives: answer.alternatives.map((recommendation) =>
          issueRecommendation(recommendation, issuance),
        ) as typeof answer.alternatives,
      };
    case "EMPTY":
      return answer;
  }
}

/**
 * ADR 0017 amendment (2026-09-03) — sign one single-use recheck nonce per showtime
 * for every resolved hit, not only `primary`/`alternatives`.
 *
 * A single showtime can be covered by multiple overlapping hits (different seat
 * blocks / placementKeys), while a nonce binds BOTH showtimeId AND placementKey —
 * so exactly one nonce is issued per showtime, bound to its "best" hit's placement
 * key. Best = the first hit in stored `groupHits` order covering that showtime with
 * a non-null `placementKey`, which is the same hit the client renders (`ShowtimeRow`
 * picks `hits[0]` of the covering hits), so `onHandoff(showtimeId)` needs no new
 * disambiguation. Non-best covering slots keep their `null` placeholder.
 *
 * Same `signRecheckNonce` primitive, same binding shape, same 10-minute expiry as
 * `issueRecheckNonces`; terminal-serve only (called from the same call site).
 * Hits without placement data (pre-amendment payloads, or hits with no candidate)
 * and unresolved showtimes are skipped, never signed.
 */
export function issueHitNonces(
  groups: ResultGroup[],
  issuance: RecheckNonceIssuance,
): ResultGroup[] {
  return groups.map((group) => {
    const hits = group.groupHits;
    if (hits === undefined || hits.length === 0) {
      return group;
    }
    // Best-hit selection per covered showtime index: first hit in stored order
    // with a placement key. Mirrors the client's `hits[0]` pick; the issue-side
    // placementKey skip is the only deliberate divergence (a key-less hit cannot
    // bind a nonce), and the client skips key-less hits identically on lookup.
    const bestHitByShowtime = new Map<number, number>();
    hits.forEach((hit, hitIndex) => {
      if (hit.placementKey === null || hit.placementKey === undefined) {
        return;
      }
      for (const showtimeIndex of hit.showtimeIndices) {
        if (!bestHitByShowtime.has(showtimeIndex)) {
          bestHitByShowtime.set(showtimeIndex, hitIndex);
        }
      }
    });
    if (bestHitByShowtime.size === 0) {
      return group;
    }
    const issuedHits = hits.map((hit, hitIndex) => {
      const placeholders = hit.showtimeNonces;
      if (placeholders === undefined) {
        return hit;
      }
      const showtimeNonces = placeholders.map((placeholder, position) => {
        const showtimeIndex = hit.showtimeIndices[position];
        if (showtimeIndex === undefined || bestHitByShowtime.get(showtimeIndex) !== hitIndex) {
          return placeholder;
        }
        const showtime = group.showtimes[showtimeIndex];
        const placementKey = hit.placementKey;
        if (showtime === undefined || showtime.resolved !== true || placementKey == null) {
          return placeholder;
        }
        return signRecheckNonce(
          {
            id: issuance.mintId(),
            sessionId: issuance.sessionId,
            searchId: issuance.searchId,
            resultVersion: issuance.resultVersion,
            showtimeId: showtime.showtimeId,
            placementKey,
            expiry: issuance.now() + RECHECK_NONCE_TTL_MS,
          },
          issuance.nonceSecret,
        );
      });
      return { ...hit, showtimeNonces };
    });
    return { ...group, groupHits: issuedHits };
  });
}
