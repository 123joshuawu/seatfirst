import { describe, expect, it, beforeEach } from "vitest";
import {
  clearCookieJar,
  getStoredCookieValue,
  parseSetCookieHeader,
  persistCookie,
  SESSION_COOKIE_NAME,
  setCookieValueForTest,
} from "./cookieJar";

describe("cookieJar", () => {
  beforeEach(() => {
    setCookieValueForTest(null);
  });

  it("parseSetCookieHeader extracts seatfirst_session value", () => {
    const raw =
      "seatfirst_session=abc123.hmac456; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600";
    expect(parseSetCookieHeader(raw)).toBe("abc123.hmac456");
  });

  it("parseSetCookieHeader returns null when absent", () => {
    expect(parseSetCookieHeader("other=value; Path=/")).toBeNull();
    expect(parseSetCookieHeader(null)).toBeNull();
    expect(parseSetCookieHeader("")).toBeNull();
  });

  it("parseSetCookieHeader handles comma-joined multi-cookie header", () => {
    const raw = "other=foo; Path=/, seatfirst_session=xyz.hmac789; Path=/; HttpOnly";
    expect(parseSetCookieHeader(raw)).toBe("xyz.hmac789");
  });

  it("persistCookie updates in-memory jar", async () => {
    await persistCookie("sess.hmac");
    expect(getStoredCookieValue()).toBe("sess.hmac");
  });

  it("clearCookieJar clears in-memory value", () => {
    setCookieValueForTest("a.b");
    clearCookieJar();
    expect(getStoredCookieValue()).toBeNull();
  });

  it("SESSION_COOKIE_NAME matches server constant", () => {
    expect(SESSION_COOKIE_NAME).toBe("seatfirst_session");
  });
});
