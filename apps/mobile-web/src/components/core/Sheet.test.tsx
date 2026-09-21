import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Sheet, sheetMaxHeightForViewport, SMALL_SHEET_VIEWPORT_HEIGHT } from "./Sheet";
import { AppText } from "./AppText";

function flatStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === "object") Object.assign(out, entry);
  }
  return out;
}

function pressByLabel(root: TestRenderer.ReactTestInstance, label: string): void {
  const btn = root
    .findAllByType(Pressable)
    .find((n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  expect(btn, `"${label}" pressable exists`).toBeDefined();
  act(() => {
    (btn!.props as { onPress: () => void }).onPress();
  });
}

describe("Sheet primitive", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
  });

  function renderSheet(props?: {
    open?: boolean;
    onClose?: () => void;
    ariaLabel?: string;
    maxWidth?: number;
    subtitle?: string;
    scrollable?: boolean;
    footer?: boolean;
  }): { root: TestRenderer.ReactTestInstance; onClose: ReturnType<typeof vi.fn> } {
    const onClose = props?.onClose ?? vi.fn();
    act(() => {
      renderer = TestRenderer.create(
        <Sheet
          open={props?.open ?? true}
          onClose={onClose}
          ariaLabel={props?.ariaLabel ?? "Test sheet"}
          {...(props?.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {})}
        >
          <Sheet.Header
            title="Test sheet"
            onClose={onClose}
            {...(props?.subtitle !== undefined ? { subtitle: props.subtitle } : {})}
          />
          <Sheet.Body
            {...(props?.scrollable !== undefined ? { scrollable: props.scrollable } : {})}
          >
            <AppText weight="400">Body content</AppText>
          </Sheet.Body>
          {props?.footer === false ? null : (
            <Sheet.Footer>
              <AppText weight="600">Footer action</AppText>
            </Sheet.Footer>
          )}
        </Sheet>,
      );
    });
    return { root: renderer!.root, onClose: onClose as ReturnType<typeof vi.fn> };
  }

  it("renders null when closed", () => {
    const { root } = renderSheet({ open: false });
    expect(renderer!.toJSON()).toBeNull();
    expect(root.findAllByType(Modal)).toHaveLength(0);
  });

  it("renders a visible transparent Modal wiring onRequestClose to onClose (Android back)", () => {
    const { root, onClose } = renderSheet();
    const modal = root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    expect(modal.props.transparent).toBe(true);
    act(() => {
      (modal.props as { onRequestClose: () => void }).onRequestClose();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes dialog ARIA attributes on web", () => {
    const { root } = renderSheet({ ariaLabel: "Custom window" });
    const overlay = root
      .findAllByType(View)
      .find((n) => (n.props as { role?: string }).role === "dialog");
    expect(overlay, "dialog overlay exists").toBeDefined();
    expect(overlay!.props["aria-modal"]).toBe("true");
    expect(overlay!.props["aria-label"]).toBe("Custom window");
  });

  it("scrim tap calls onClose", () => {
    const { root, onClose } = renderSheet();
    pressByLabel(root, "Close dialog");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onClose; non-Escape keys do not", () => {
    const { onClose } = renderSheet();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closed sheet subscribes to nothing: Escape does not call onClose", () => {
    const onClose = vi.fn();
    act(() => {
      renderer = TestRenderer.create(
        <Sheet open={false} onClose={onClose} ariaLabel="Test sheet">
          <Sheet.Body>Body</Sheet.Body>
        </Sheet>,
      );
    });
    expect(renderer!.toJSON()).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Header close button fires onClose and meets the 44x44 touch target", () => {
    const { root, onClose } = renderSheet();
    const btn = root
      .findAllByType(Pressable)
      .find(
        (n) =>
          (n.props as { accessibilityLabel?: string }).accessibilityLabel === "Close Test sheet",
      );
    expect(btn, "header close exists").toBeDefined();
    const style = btn!.props.style as { minWidth?: number; minHeight?: number };
    const hitSlop = btn!.props.hitSlop as
      { top?: number; bottom?: number; left?: number; right?: number } | undefined;
    expect(
      (style.minWidth ?? 0) + (hitSlop?.left ?? 0) + (hitSlop?.right ?? 0),
    ).toBeGreaterThanOrEqual(44);
    expect(
      (style.minHeight ?? 0) + (hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0),
    ).toBeGreaterThanOrEqual(44);
    pressByLabel(root, "Close Test sheet");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Header renders the subtitle only when provided", () => {
    renderSheet({ subtitle: "Pick any dates." });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Pick any dates.");
    renderer!.unmount();
    renderSheet();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Pick any dates.");
  });

  it("Body scrollable renders a flex:1/minHeight:0 ScrollView; non-scrollable a plain View", () => {
    const { root } = renderSheet({ footer: false });
    const bodies = root.findAllByType(ScrollView);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.props.style).toMatchObject({ flex: 1, minHeight: 0 });
    renderer!.unmount();

    const onClose = vi.fn();
    act(() => {
      renderer = TestRenderer.create(
        <Sheet open={true} onClose={onClose} ariaLabel="Test sheet">
          <Sheet.Body scrollable={false}>
            <AppText weight="400">Static</AppText>
          </Sheet.Body>
        </Sheet>,
      );
    });
    expect(renderer!.root.findAllByType(ScrollView)).toHaveLength(0);
    const bodyView = renderer!.root.findByType(Sheet.Body).findByType(View);
    expect(bodyView.props.style).toMatchObject({ flex: 1, minHeight: 0 });
  });

  it("Footer is a fixed (flexShrink:0) container outside the scrollable body", () => {
    const { root } = renderSheet();
    const footer = root.findByType(Sheet.Footer);
    const footerView = footer.findAllByType(View)[0]!;
    expect(footerView.props.style).toMatchObject({ flexShrink: 0 });
    // Footer content is not inside the scrollable body: the P0 structural fix.
    const body = root.findByType(Sheet.Body);
    expect(
      body.findAll((node) => (node.props as { children?: unknown }).children === "Footer action"),
    ).toHaveLength(0);
    expect(
      footer.findAllByType(AppText).map((n) => (n.props as { children?: unknown }).children),
    ).toContain("Footer action");
  });

  it("panel caps height (90% at test-viewport 768px) with a 440 default maxWidth", () => {
    const { root } = renderSheet();
    const panel = root.findByType(Sheet.Body).parent!;
    const panelStyle = flatStyle((panel.props as { style: unknown }).style);
    // The mocked viewport is 1024x768 (>= the 740 small-phone breakpoint).
    expect(panelStyle.maxHeight).toBe("90%");
    expect(panelStyle.maxWidth).toBe(440);
    expect(panelStyle.flex).toBeUndefined();
    renderer!.unmount();

    renderSheet({ maxWidth: 400 });
    const narrowPanel = renderer!.root.findByType(Sheet.Body).parent!;
    expect(flatStyle((narrowPanel.props as { style: unknown }).style).maxWidth).toBe(400);
  });

  it("header stays fixed: header row and footer carry flexShrink:0, body carries the flex", () => {
    const { root } = renderSheet();
    const headerRow = root.findByType(Sheet.Header).findByType(View);
    expect(headerRow.props.style).toMatchObject({ flexShrink: 0 });
  });
});

describe("sheetMaxHeightForViewport", () => {
  it(`caps small phones (< ${SMALL_SHEET_VIEWPORT_HEIGHT}px) at 85%, regular at 90%`, () => {
    expect(sheetMaxHeightForViewport(667)).toBe("85%");
    expect(sheetMaxHeightForViewport(SMALL_SHEET_VIEWPORT_HEIGHT - 1)).toBe("85%");
    expect(sheetMaxHeightForViewport(SMALL_SHEET_VIEWPORT_HEIGHT)).toBe("90%");
    expect(sheetMaxHeightForViewport(844)).toBe("90%");
  });
});
