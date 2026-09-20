import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, ScrollView } from "react-native";
import { WhenCustomSheet } from "./WhenCustomSheet";
import { HowItWorksSheet } from "./HowItWorksSheet";
import { AppText } from "@/components/core/AppText";
import { useSeatfirstStore } from "@/store/seatfirstStore";

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  const value = node as { children?: unknown; props?: { children?: unknown } };
  return textContent(value.children ?? value.props?.children);
}

function spanText(root: TestRenderer.ReactTestInstance): string {
  const hit = root
    .findAllByType(AppText)
    .map(textContent)
    .find((t) => /day(s)? selected|pick at least one date/.test(t));
  return hit ?? "";
}

function pressByLabel(root: TestRenderer.ReactTestInstance, label: string): void {
  const btn = root
    .findAllByType(Pressable)
    .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  expect(btn, `"${label}" button exists`).toBeDefined();
  act(() => {
    (btn!.props as { onPress: () => void }).onPress();
  });
}

describe("mobile sheet full-height layout (P0-3)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.setSystemTime(new Date(2026, 7, 29, 12, 0));
    useSeatfirstStore.setState({ whenSheetOpen: true, selectedDates: [] });
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    useSeatfirstStore.setState({ whenSheetOpen: false });
    vi.useRealTimers();
  });

  it("WhenCustomSheet body scrolls with header/footer outside, no sub-viewport cap", () => {
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    const bodies = root.findAllByType(ScrollView);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    const panelStyle = (body.parent!.props as { style: Record<string, unknown> }).style;
    expect(panelStyle.flex).toBe(1);
    expect(panelStyle.maxHeight).toBeUndefined();
    const insideLabels = body
      .findAllByType(Pressable)
      .map((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel);
    for (const label of ["Clear dates", "Cancel", "Apply"]) {
      expect(insideLabels).not.toContain(label);
    }
    const insideText = body.findAllByType(AppText).map(textContent).join(" ");
    expect(insideText).not.toContain("Custom window");
  });

  it("weekday header stays pinned (sticky) at the top of the scrolling calendar", () => {
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    const body = root.findByType(ScrollView);
    // Sticky only takes effect inside the scroll container: the header must
    // live inside the ScrollView (not in the pinned footer).
    const header = body.find(
      (node) => (node.props as { testID?: string })?.testID === "calendar-weekday-header",
    );
    const style = header.props.style as {
      position?: string;
      top?: number;
      backgroundColor?: string;
      zIndex?: number;
    };
    expect(style.position).toBe("sticky");
    expect(style.top).toBe(0);
    // Opaque background + stacking so month headings/cells scrolling
    // underneath never bleed through the pinned row.
    expect(style.backgroundColor).toBeDefined();
    expect(style.zIndex).toBeDefined();
    // Sunday-first weekday labels render in order inside the pinned row.
    const labels = header.findAllByType(AppText).map(textContent);
    expect(labels).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    // Month sections still render below the header inside the same ScrollView.
    const monthHeadings = body
      .findAllByType(AppText)
      .map(textContent)
      .filter((t) => /20\d\d/.test(t));
    expect(monthHeadings.length).toBeGreaterThan(0);
  });

  it("Clear dates resets the draft to the default 3-day window (P2-11)", () => {
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    expect(spanText(root)).toContain("3 days selected");
    // Toggle one calendar day cell (all day cells live inside the ScrollView).
    const body = root.findByType(ScrollView);
    const dayCell = body
      .findAllByType(Pressable)
      .find((n) => typeof (n.props as { onPress?: unknown }).onPress === "function");
    expect(dayCell).toBeDefined();
    act(() => {
      (dayCell!.props as { onPress: () => void }).onPress();
    });
    expect(spanText(root)).not.toContain("3 days selected");
    pressByLabel(root, "Clear dates");
    expect(spanText(root)).toContain("3 days selected");
  });

  it("HowItWorksSheet body scrolls with the close action outside, no sub-viewport cap", () => {
    act(() => {
      renderer = TestRenderer.create(<HowItWorksSheet open={true} onClose={() => {}} />);
    });
    const root = renderer!.root;
    const bodies = root.findAllByType(ScrollView);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    const panelStyle = (body.parent!.props as { style: Record<string, unknown> }).style;
    expect(panelStyle.flex).toBe(1);
    expect(panelStyle.maxHeight).toBeUndefined();
    const insideLabels = body
      .findAllByType(Pressable)
      .map((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel);
    expect(insideLabels).not.toContain("Close how it works");
  });
});

describe("WhenCustomSheet Cancel/Apply preset reconciliation (ADR 0044 amendment)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.setSystemTime(new Date(2026, 7, 29, 12, 0));
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    useSeatfirstStore.setState({ whenSheetOpen: false });
    vi.useRealTimers();
  });

  it("Cancel with no edits reconciles the eager Custom flag back to Tonight", () => {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Tonight");
    });
    const tonightDates = useSeatfirstStore.getState().selectedDates;
    // Tapping the Custom chip eagerly flags Custom without changing the commit.
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Custom");
    });
    expect(useSeatfirstStore.getState().whenPreset).toBe("Custom");
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    pressByLabel(root, "Cancel");
    const s = useSeatfirstStore.getState();
    expect(s.whenPreset).toBe("Tonight");
    expect(s.isCustom).toBe(false);
    expect(s.whenSheetOpen).toBe(false);
    expect(s.selectedDates).toEqual(tonightDates);
  });

  it("Apply canonicalizes a draft that exactly matches Tonight instead of staying Custom", () => {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("This weekend");
    });
    // Tapping the Custom chip opens the sheet; the draft seeds from the
    // committed This-weekend dates.
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Custom");
    });
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    // Deselect Sunday so the draft is exactly Tonight's live resolution.
    const sundayLabel = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(2026, 7, 30));
    pressByLabel(root, sundayLabel);
    pressByLabel(root, "Apply");
    const s = useSeatfirstStore.getState();
    expect(s.whenPreset).toBe("Tonight");
    expect(s.isCustom).toBe(false);
    expect(s.whenSheetOpen).toBe(false);
  });

  it("Cancel keeps a genuinely custom commit instead of discarding it", () => {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("This weekend");
    });
    // Clearing the band to Any time makes the commit genuinely custom: no
    // named preset resolves to an empty band set.
    act(() => {
      useSeatfirstStore.getState().toggleBand("Any time");
    });
    expect(useSeatfirstStore.getState().whenPreset).toBe("Custom");
    const committedDates = useSeatfirstStore.getState().selectedDates;
    // Tapping the Custom chip opens the sheet without touching the commit.
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Custom");
    });
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    const root = renderer!.root;
    // No calendar edits: Cancel must drop only the sheet's local draft, which
    // was never committed, and leave the committed custom state alone.
    pressByLabel(root, "Cancel");
    const s = useSeatfirstStore.getState();
    expect(s.whenPreset).toBe("Custom");
    expect(s.isCustom).toBe(true);
    expect(s.whenSheetOpen).toBe(false);
    expect(s.selectedDates).toEqual(committedDates);
    expect(s.selectedBands).toEqual([]);
  });
});

describe("WhenCustomSheet draft bands (ADR 0044 amendment 2026-09-05)", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 12, 0));
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    useSeatfirstStore.setState({ whenSheetOpen: false });
    vi.useRealTimers();
  });

  function bandChip(
    root: TestRenderer.ReactTestInstance,
    label: string,
  ): TestRenderer.ReactTestInstance {
    // Band chips render as "Morning, 12AM–…" density chips; match the label prefix.
    const hits = root.findAllByType(Pressable).filter((n) => {
      const a11y = (n.props as { accessibilityLabel?: string }).accessibilityLabel;
      return a11y === label || a11y?.startsWith(`${label},`);
    });
    expect(hits, `"${label}" band chip exists`).toHaveLength(1);
    return hits[0]!;
  }

  function openSheet(): TestRenderer.ReactTestInstance {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Custom");
    });
    act(() => {
      renderer = TestRenderer.create(<WhenCustomSheet />);
    });
    return renderer!.root;
  }

  it("opening the sheet seeds the band chips from the committed selectedBands", () => {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Tonight");
    });
    expect(useSeatfirstStore.getState().selectedBands).toEqual(["Evening"]);
    const root = openSheet();
    expect(bandChip(root, "Evening").props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(bandChip(root, "Morning").props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(bandChip(root, "Any time").props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it("tapping a band chip updates the draft only; Cancel leaves the commit unchanged", () => {
    act(() => {
      useSeatfirstStore.getState().selectWhenPreset("Tonight");
    });
    const root = openSheet();
    act(() => {
      (bandChip(root, "Morning").props as { onPress: () => void }).onPress();
    });
    // The draft flips (Morning extends the Evening span) while the commit sits still.
    expect(bandChip(root, "Morning").props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(useSeatfirstStore.getState().selectedBands).toEqual(["Evening"]);
    pressByLabel(root, "Cancel");
    const s = useSeatfirstStore.getState();
    expect(s.selectedBands).toEqual(["Evening"]);
    expect(s.whenSheetOpen).toBe(false);
  });

  it("Apply commits an edited date and band combination together, atomically", () => {
    act(() => {
      useSeatfirstStore.setState({
        selectedDates: ["2026-09-04", "2026-09-08"],
        selectedBands: ["Evening"],
        whenPreset: "Custom",
        isCustom: true,
      });
    });
    const root = openSheet();
    // Drop Fri Sep 4 from the draft and extend the band span upward to Morning.
    const fridayLabel = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(2026, 8, 4));
    pressByLabel(root, fridayLabel);
    act(() => {
      (bandChip(root, "Morning").props as { onPress: () => void }).onPress();
    });
    // Neither axis commits before Apply.
    expect(useSeatfirstStore.getState().selectedDates).toEqual(["2026-09-04", "2026-09-08"]);
    expect(useSeatfirstStore.getState().selectedBands).toEqual(["Evening"]);
    pressByLabel(root, "Apply");
    // One Apply lands both axes in the same resulting store state.
    const s = useSeatfirstStore.getState();
    expect(s.selectedDates).toEqual(["2026-09-08"]);
    expect(s.selectedBands).toEqual(["Morning", "Afternoon", "Evening"]);
    expect(s.whenPreset).toBe("Custom");
    expect(s.isCustom).toBe(true);
    expect(s.whenSheetOpen).toBe(false);
  });
});
