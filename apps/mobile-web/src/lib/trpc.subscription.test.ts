import type * as TrpcClient from "@trpc/client";
import { describe, expect, it, vi } from "vitest";

const { httpSubscriptionLinkMock } = vi.hoisted(() => ({
  httpSubscriptionLinkMock: vi.fn(() => vi.fn()),
}));

vi.mock("@trpc/client", async () => ({
  ...(await vi.importActual<typeof TrpcClient>("@trpc/client")),
  httpSubscriptionLink: httpSubscriptionLinkMock,
}));

describe("tRPC subscription transport", () => {
  it("enables credentials for the browser EventSource", async () => {
    await import("./trpc");

    expect(httpSubscriptionLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventSourceOptions: { withCredentials: true },
      }),
    );
  });
});
