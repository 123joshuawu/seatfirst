/**
 * Cookie-jar / session credential helper for UI9 tests.
 * Wraps the real cookieJar module's test seam (`setCookieValueForTest`,
 * `getStoredCookieValue`, `clearCookieJar`) plus an in-memory persistence
 * double so "restart" scenarios can keep the jar while clearing zustand.
 */
import { vi } from "vitest";
import { clearCookieJar, getStoredCookieValue, setCookieValueForTest } from "@/lib/cookieJar";

export const SESSION_COOKIE_NAME = "seatfirst_session";

/** Build a plausible session cookie value `sessionId.hmac`. */
export function fakeSessionCookie(sessionId = "sess_abc123"): string {
  return `${sessionId}.hmac_${sessionId}_sig`;
}

export function setSessionCookie(value: string | null): void {
  setCookieValueForTest(value);
}

export function getSessionCookie(): string | null {
  return getStoredCookieValue();
}

export function clearSession(): void {
  clearCookieJar();
}

/** Spy for persist/hydrate that would hit expo-secure-store on device. */
export const mockPersistCookie = vi.fn(() => Promise.resolve());
export const mockHydrateCookieJar = vi.fn(() => Promise.resolve());
