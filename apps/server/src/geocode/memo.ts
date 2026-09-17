/**
 * Process-local, session-scoped geocode memo (S51, ADR 0045 §1, §4).
 *
 * No Postgres, no durable storage, no new ADR 0002 §3.2 data class — the
 * memo is an in-memory `Map` keyed by `${sessionId}\0${normalizedQueryLower}`
 * so radius-chip retries within one form session skip a re-bill. Process-
 * local, not shared across processes, empty on restart. Entries have a
 * 10-minute sliding TTL; the process-wide 1,024-entry cap evicts
 * least-recently-used entries to bound growth and prevent cross-session reuse.
 */

export const GEOCODE_MEMO_TTL_MS = 10 * 60 * 1000;
export const GEOCODE_MEMO_MAX_ENTRIES = 1024;

export interface GeocodeCoords {
  readonly lat: number;
  readonly lng: number;
}

interface MemoEntry<T> {
  readonly value: T;
  expiresAt: number;
}

export interface GeocodeMemoDeps {
  /** Epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class GeocodeMemo<T = GeocodeCoords> {
  private readonly now: () => number;
  private readonly store = new Map<string, MemoEntry<T>>();

  constructor(deps: GeocodeMemoDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  private key(sessionId: string, normalizedQueryLower: string): string {
    return `${sessionId}\0${normalizedQueryLower}`;
  }

  /**
   * Retrieve a cached value for the session+query. Returns `null` on
   * miss or expiry. On hit, updates LRU order (re-insert) and extends the
   * sliding TTL (expiry = now + 10 min).
   */
  get(sessionId: string, normalizedQueryLower: string): T | null {
    const k = this.key(sessionId, normalizedQueryLower);
    const entry = this.store.get(k);
    if (!entry) return null;
    const t = this.now();
    if (entry.expiresAt <= t) {
      this.store.delete(k);
      return null;
    }
    // Sliding TTL: extend on hit
    entry.expiresAt = t + GEOCODE_MEMO_TTL_MS;
    // LRU: move to most-recent by reinserting
    this.store.delete(k);
    this.store.set(k, entry);
    return entry.value;
  }

  set(sessionId: string, normalizedQueryLower: string, value: T): void {
    const k = this.key(sessionId, normalizedQueryLower);
    const t = this.now();
    // If key already exists, delete first so re-insert counts as most-recent
    if (this.store.has(k)) this.store.delete(k);
    // Evict LRU until under cap (Map iteration order is insertion order)
    while (this.store.size >= GEOCODE_MEMO_MAX_ENTRIES) {
      const lruKey = this.store.keys().next().value;
      if (lruKey === undefined) break;
      this.store.delete(lruKey);
    }
    this.store.set(k, {
      value,
      expiresAt: t + GEOCODE_MEMO_TTL_MS,
    });
  }

  /** Test helper: clear all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Test helper: current entry count (including not-yet-expired). */
  get size(): number {
    return this.store.size;
  }
}

export function createGeocodeMemo<T = GeocodeCoords>(deps: GeocodeMemoDeps = {}): GeocodeMemo<T> {
  return new GeocodeMemo<T>(deps);
}
