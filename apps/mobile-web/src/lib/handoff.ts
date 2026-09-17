/**
 * Deep-link handoff — opens the server-provided, host-allowlist-validated
 * deepLinkUrl verbatim. Never synthesizes a URL from IDs.
 *
 * Spec UI6.6.
 */
import { Linking, Platform } from "react-native";

/**
 * Open the given deepLinkUrl verbatim.
 * Returns true if the URL was opened, false otherwise.
 */
export async function openHandoff(deepLinkUrl: string): Promise<boolean> {
  if (!deepLinkUrl || deepLinkUrl.trim().length === 0) return false;
  try {
    // Validate it is an HTTPS URL before opening — matches server allowlist
    // expectation (validateShowtimeIdentity requires https + allowlisted host).
    const parsed = new URL(deepLinkUrl);
    if (parsed.protocol !== "https:") return false;
    await Linking.openURL(deepLinkUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * UI30 (ADR 0063 §4) — pop-up-blocker-safe handoff handle.
 *
 * Browsers only honour `window.open(url)` synchronously inside the user gesture;
 * awaiting `showtimes.recheck` first gets the new tab blocked as an untrusted
 * popup. So the tap handler calls `preopenHandoffWindow()` synchronously, threads
 * the handle through the async recheck, then either navigates the held tab
 * (`completeHandoffWithPopup`) or drops it (`closeHandoffWindow`).
 *
 * Minimal structural shape (not `Window`) so native callers — where `window.open`
 * does not exist and the handle is always null — never touch DOM types.
 */
export interface HandoffPopupWindow {
  readonly closed?: boolean;
  readonly location?: { href: string };
  close(): void;
}

/**
 * Synchronously pre-open a blank tab on the tap gesture (web only). Returns null
 * on native, when `window.open` is unavailable, or when the browser blocks even
 * the gesture-bound open — callers fall back to a direct `openHandoff`.
 */
export function preopenHandoffWindow(): HandoffPopupWindow | null {
  if (Platform.OS !== "web") return null;
  if (typeof window === "undefined" || typeof window.open !== "function") return null;
  try {
    const opened = window.open("about:blank", "_blank");
    if (opened === null || typeof opened === "undefined") return null;
    return opened;
  } catch {
    return null;
  }
}

/**
 * AVAILABLE path: navigate the pre-opened tab to the deep link. Falls back to a
 * direct `openHandoff` when no tab was held (native, blocked pre-open, or the
 * user already closed it) — the row then shows the explicit success link.
 */
export async function completeHandoffWithPopup(
  deepLinkUrl: string,
  popup: HandoffPopupWindow | null,
): Promise<boolean> {
  if (popup !== null) {
    try {
      if (popup.closed !== true && popup.location !== undefined) {
        popup.location.href = deepLinkUrl;
        return true;
      }
    } catch {
      // Held tab is unusable — fall through to a direct open below.
    }
  }
  return openHandoff(deepLinkUrl);
}

/**
 * GONE / UNAVAILABLE / error path: immediately drop the pre-opened blank tab so
 * a failed recheck never strands an empty tab. Null-safe no-op otherwise.
 */
export function closeHandoffWindow(popup: HandoffPopupWindow | null): void {
  if (popup === null) return;
  try {
    if (popup.closed !== true) popup.close();
  } catch {
    // Tab already gone — nothing to close.
  }
}

/**
 * Resolve a deepLinkUrl from the given showtimeId via the provided
 * groups' showtimes. Returns null if no matching offer exists.
 */
export function resolveDeepLinkForShowtime(
  showtimeId: string,
  groups: readonly {
    readonly showtimes: readonly { readonly showtimeId: string; readonly deepLinkUrl: string }[];
  }[],
): string | null {
  for (const group of groups) {
    for (const showtime of group.showtimes) {
      if (showtime.showtimeId === showtimeId) return showtime.deepLinkUrl;
    }
  }
  return null;
}
