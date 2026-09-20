import { useEffect, useState, type ReactElement } from "react";
import { View, Pressable, ScrollView, Platform } from "react-native";
import { AppText } from "@/components/core/AppText";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { CustomDateCalendar } from "./CustomDateCalendar";
import { useWhenCustomSheetViewModel } from "@/hooks/viewModels/useWhenCustomSheetViewModel";
import { ChipRow } from "./ChipRow";
import { MOVIE_BROWSE_SPAN_DAYS } from "@/lib/dates";

export function WhenCustomSheet({ isMobile }: { isMobile?: boolean } = {}): ReactElement | null {
  const desktop = isMobile === false;
  const vm = useWhenCustomSheetViewModel();
  const [scrollLayoutHeight, setScrollLayoutHeight] = useState(0);
  const [scrollContentHeight, setScrollContentHeight] = useState(0);
  const [scrollOffsetY, setScrollOffsetY] = useState(0);

  // BUG-03: web-only Escape-to-dismiss (matches the `Platform.OS === "web"` +
  // `document` guard convention in Autocomplete's `useOutsidePointerDownDismiss`
  // and HowItWorksSheet). Reuses the same `handleCancel` the Cancel button
  // calls, so Escape discards the draft exactly like Cancel. Hooks stay above
  // the `!whenSheetOpen` early return so hook order is stable across renders.
  useEffect(() => {
    if (!vm.whenSheetOpen) return;
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") vm.actions.handleCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [vm.whenSheetOpen, vm.actions.handleCancel]);
  if (!vm.whenSheetOpen) return null;

  // Bottom fade (web-only, matches LeftPanel's poster-stripe convention of a
  // web-only CSS gradient with no native fallback): hints that the calendar
  // has more months below when the OS scrollbar is hidden by default (e.g.
  // macOS trackpad scrolling), and disappears once actually scrolled to the
  // bottom so it never looks like a rendering artifact.
  const hasMoreBelow =
    scrollContentHeight > scrollLayoutHeight + 1 &&
    scrollOffsetY + scrollLayoutHeight < scrollContentHeight - 2;

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
        zIndex: 100,
      }}
      accessible={true}
      accessibilityLabel="Custom window"
    >
      {/* BUG-03: scrim Pressable behind a separately-hit-tested panel (mirrors
        `AutocompletePopover`'s mobile sheet branch `sheetScrim` + `sheetPanel`):
        tapping the dark backdrop calls the same `handleCancel` as the Cancel
        button, while taps inside the white card hit the panel sibling above
        and never dismiss. */}
      <Pressable
        onPress={vm.actions.handleCancel}
        accessibilityRole="button"
        accessibilityLabel="Close custom window dialog"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
      />
      <View
        style={{
          backgroundColor: "#fff",
          borderRadius: 12,
          // UX-01: tighter panel chrome (was padding 16 / gap 12) hands ~24px
          // of vertical budget back to the calendar ScrollView below, so the
          // second month and the selection summary are visible without
          // scrolling at 1280x900. The `hasMoreBelow` fade stays as fallback.
          padding: 12,
          width: "100%",
          maxWidth: 400,
          flex: 1,
          gap: 8,
          overflow: "hidden",
        }}
      >
        <AppText weight="700" style={{ fontSize: 16 }}>
          Custom window
        </AppText>
        <AppText weight="400" style={{ fontSize: 13, color: "#6B7280" }}>
          Pick any dates in the next 30 days.
        </AppText>

        <View style={{ flex: 1, minHeight: 0, position: "relative" }}>
          <ScrollView
            style={{ flex: 1, minHeight: 0 }}
            showsVerticalScrollIndicator={true}
            onLayout={(e) => setScrollLayoutHeight(e.nativeEvent.layout.height)}
            onContentSizeChange={(_w, h) => setScrollContentHeight(h)}
            onScroll={(e) => setScrollOffsetY(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
          >
            <EyebrowLabel marginBottom={4}>Dates</EyebrowLabel>
            <CustomDateCalendar
              selectedDates={vm.draftDates}
              minIso={vm.minIso}
              maxIso={vm.maxIso}
              onSelectDay={vm.actions.onSelectDay}
              {...(vm.dateCounts ? { facetCounts: vm.dateCounts } : {})}
              {...(vm.totalTheatres !== undefined ? { totalTheatres: vm.totalTheatres } : {})}
            />
            {vm.draftReadout ? (
              <AppText
                weight="400"
                style={{ fontSize: 12, color: "#111827" }}
                accessibilityLabel={`Selected: ${vm.draftReadout}`}
              >
                {vm.draftReadout}
              </AppText>
            ) : null}
            <AppText
              weight="400"
              style={{
                fontSize: 11,
                color: vm.spanDays > MOVIE_BROWSE_SPAN_DAYS ? "#DC2626" : "#6B7280",
              }}
            >
              {vm.draftDates.length
                ? `${vm.draftDates.length} day${vm.draftDates.length === 1 ? "" : "s"} selected · ${vm.spanDays}-day span (max ${MOVIE_BROWSE_SPAN_DAYS})`
                : "pick at least one date"}
            </AppText>
            {vm.error ? (
              <AppText weight="500" style={{ fontSize: 12, color: "#DC2626" }}>
                {vm.error}
              </AppText>
            ) : null}
          </ScrollView>
          {hasMoreBelow ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 28,
                ...(Platform.OS === "web"
                  ? {
                      backgroundImage:
                        "linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,1))",
                    }
                  : {}),
              }}
            />
          ) : null}
        </View>

        <ChipRow label="Time of day" chips={vm.bandChips} marginBottom={0} />
        <View
          testID="custom-sheet-footer"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            // Mobile 390px: 'Clear dates' plus the Cancel/Apply pair can exceed
            // the panel content width (e.g. under text scaling), so the row
            // wraps instead of clipping Cancel/Apply off-screen. Desktop keeps
            // the single-line layout (`undefined` keeps mobile values, matching
            // the `isMobile` tri-state convention elsewhere in the form).
            flexWrap: desktop ? "nowrap" : "wrap",
            gap: 8,
            // UX-01: was marginTop 12 + paddingBottom 8; trims 12px more of
            // fixed chrome for the calendar ScrollView above.
            marginTop: 8,
            flexShrink: 0,
            backgroundColor: "#fff",
          }}
        >
          <Pressable
            onPress={vm.actions.handleClearDates}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "#D1D5DB",
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear dates"
          >
            <AppText weight="600" style={{ fontSize: 14 }}>
              Clear dates
            </AppText>
          </Pressable>
          {/* flexShrink 0 keeps Cancel/Apply together as one wrap unit. */}
          <View style={{ flexDirection: "row", gap: 8, flexShrink: 0 }}>
            <Pressable
              onPress={vm.actions.handleCancel}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#D1D5DB",
              }}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <AppText weight="600" style={{ fontSize: 14 }}>
                Cancel
              </AppText>
            </Pressable>
            <Pressable
              onPress={vm.actions.handleApply}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 8,
                backgroundColor: "#111827",
              }}
              accessibilityRole="button"
              accessibilityLabel="Apply"
            >
              <AppText weight="600" style={{ fontSize: 14, color: "#fff" }}>
                Apply
              </AppText>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
