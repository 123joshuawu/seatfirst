import { afterEach, describe, expect, it, vi } from "vitest";
import { Linking } from "react-native";

import {
  closeHandoffWindow,
  completeHandoffWithPopup,
  openHandoff,
  preopenHandoffWindow,
  resolveDeepLinkForShowtime,
  type HandoffPopupWindow,
} from "./handoff";

/**
 * P9 — the handoff opens the server-provided seat-level deep link verbatim, carrying
 * the placement's pre-selected seats (`?seats=<seatNames>`, ADR 0002 §3.5 Phase 2).
 * `openHandoff` never synthesizes URLs (UI6.6); these tests pin that the seat-level
 * shape passes through untouched.
 */
describe("openHandoff with seat-level deep links (P9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the seats URL with query params verbatim", async () => {
    const openURL = vi.spyOn(Linking, "openURL");
    const seatsUrl = "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10,J9,J8,J7";
    await expect(openHandoff(seatsUrl)).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(seatsUrl);
  });

  it("positive control: a clean baseline seats URL still opens", async () => {
    const openURL = vi.spyOn(Linking, "openURL");
    const baselineUrl = "https://www.amctheatres.com/showtimes/146027740/seats";
    await expect(openHandoff(baselineUrl)).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith(baselineUrl);
  });

  it("negative control: non-HTTPS and empty URLs never reach openURL", async () => {
    const openURL = vi.spyOn(Linking, "openURL");
    await expect(
      openHandoff("http://www.amctheatres.com/showtimes/1/seats?seats=A1"),
    ).resolves.toBe(false);
    await expect(openHandoff("")).resolves.toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe("resolveDeepLinkForShowtime carries the seat-level URL (P9)", () => {
  it("returns the offer's ?seats= URL for the matching showtime", () => {
    const groups = [
      {
        showtimes: [
          {
            showtimeId: "amc:showtime:146027740",
            deepLinkUrl: "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10,J9,J8,J7",
          },
        ],
      },
    ];
    expect(resolveDeepLinkForShowtime("amc:showtime:146027740", groups)).toBe(
      "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10,J9,J8,J7",
    );
  });

  it("returns null when no offer matches", () => {
    expect(resolveDeepLinkForShowtime("amc:showtime:9", [])).toBeNull();
  });
});

/**
 * ADR 0063 §4 — pop-up-blocker-safe handoff: the tap gesture synchronously
 * pre-opens a blank tab, the AVAILABLE path navigates it to the deep link, and
 * every other path drops it. `Platform.OS` is `"web"` under the react-native
 * mock, so these run the web branch; `window.open` is spied per test.
 */
describe("popup pre-open / complete / close (ADR 0063 §4)", () => {
  const DEEP_LINK = "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10,J9,J8,J7";
  function fakePopup(over: Partial<HandoffPopupWindow> = {}): HandoffPopupWindow {
    return { closed: false, location: { href: "" }, close: () => {}, ...over };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pre-opens synchronously with ('about:blank', '_blank')", () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    expect(preopenHandoffWindow()).toBe(popup);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  });

  it("returns null when the browser blocks even the gesture-bound pre-open", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(preopenHandoffWindow()).toBeNull();
  });

  it("navigates the held tab on success without a direct open", async () => {
    const popup = fakePopup();
    const openURL = vi.spyOn(Linking, "openURL");
    await expect(completeHandoffWithPopup(DEEP_LINK, popup)).resolves.toBe(true);
    expect(popup.location?.href).toBe(DEEP_LINK);
    expect(openURL).not.toHaveBeenCalled();
  });

  it("falls back to a direct open when no tab was held", async () => {
    const openURL = vi.spyOn(Linking, "openURL");
    await expect(completeHandoffWithPopup(DEEP_LINK, null)).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(DEEP_LINK);
  });

  it("falls back to a direct open when the held tab was already closed", async () => {
    const popup = fakePopup({ closed: true });
    const openURL = vi.spyOn(Linking, "openURL");
    await expect(completeHandoffWithPopup(DEEP_LINK, popup)).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith(DEEP_LINK);
  });

  it("closes a live popup and is a safe no-op for null", () => {
    const onClose = vi.fn();
    const popup = fakePopup({ close: onClose });
    expect(() => closeHandoffWindow(popup)).not.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
    const alreadyClosed = vi.fn();
    closeHandoffWindow(fakePopup({ closed: true, close: alreadyClosed }));
    expect(alreadyClosed).not.toHaveBeenCalled();
    expect(() => closeHandoffWindow(null)).not.toThrow();
  });
});
