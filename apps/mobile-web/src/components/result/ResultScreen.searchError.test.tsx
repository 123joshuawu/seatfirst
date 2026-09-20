import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer from "react-test-renderer";
import { ResultScreen } from "./ResultScreen";
import { SecondaryButton } from "@/components/core/Button";
import { makeMockVm, setMockVm, type MockViewModel } from "../../../test/mockViewModels";

vi.mock("@/hooks/viewModels/useSubmitSearchViewModel", () => ({
  useSubmitSearchViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchProgressViewModel", () => ({
  useSearchProgressViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useSearchResultsViewModel", () => ({
  useSearchResultsViewModel: vi.fn(),
}));
vi.mock("@/hooks/viewModels/useHandoffViewModel", () => ({ useHandoffViewModel: vi.fn() }));

function renderScreen(vm: MockViewModel): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create((setMockVm(vm), React.createElement(ResultScreen, null)));
  });
  return renderer;
}

describe("ResultScreen — terminal search error card", () => {
  it("renders an error card instead of the skeleton when the progress VM reports an error", () => {
    const renderer = renderScreen(
      makeMockVm({
        isChecking: true,
        searchStatus: "RUNNING",
        error: { message: "Internal server error", code: "INTERNAL_SERVER_ERROR" },
      }),
    );
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Couldn't check seats");
    expect(str).toContain("Internal server error");
    expect(str).toContain("Try again");
    // The skeleton/progress copy is halted entirely — no checking line.
    expect(str).not.toContain("Scanning seating charts");
    expect(str).not.toContain("Checking showtimes");
  });

  it("maps CONTINUATION_NOT_DEFERRED to friendly copy instead of the raw backend code", () => {
    const renderer = renderScreen(
      makeMockVm({
        isChecking: true,
        searchStatus: "RUNNING",
        error: {
          message: "continuation requires BATCH_DEFERRED terminal cause",
          code: "CONTINUATION_NOT_DEFERRED",
        },
      }),
    );
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Couldn't check seats");
    expect(str).toContain("still loading");
    expect(str).not.toContain("CONTINUATION_NOT_DEFERRED");
    expect(str).not.toContain("BATCH_DEFERRED");
  });

  it("does not render the error card when error is null", () => {
    const renderer = renderScreen(makeMockVm({ error: null }));
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("Couldn't check seats");
    expect(str).not.toContain("Try again");
  });

  it("retry clears the error and resubmits via the form start action", () => {
    const clearSearchError = vi.fn();
    const startSearch = vi.fn();
    const renderer = renderScreen(
      makeMockVm({
        error: { message: "boom" },
        actions: { clearSearchError, startSearch },
      }),
    );
    const retry = renderer.root.findByType(SecondaryButton);
    expect(retry.props.label).toBe("Try again");
    TestRenderer.act(() => {
      (retry.props as { onPress: () => void }).onPress();
    });
    expect(clearSearchError).toHaveBeenCalledTimes(1);
    expect(startSearch).toHaveBeenCalledTimes(1);
  });
});
