import { useState, type ReactElement } from "react";
import { View, Pressable, ScrollView, Platform } from "react-native";
import { AppText } from "@/components/core/AppText";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { CustomDateCalendar } from "./CustomDateCalendar";
import { useWhenCustomSheetViewModel } from "@/hooks/viewModels/useWhenCustomSheetViewModel";
import { ChipRow } from "./ChipRow";
import { MOVIE_BROWSE_SPAN_DAYS } from "@/lib/dates";

export function WhenCustomSheet(): ReactElement | null {
  const vm = useWhenCustomSheetViewModel();
  const [scrollLayoutHeight, setScrollLayoutHeight] = useState(0);
  const [scrollContentHeight, setScrollContentHeight] = useState(0);
  const [scrollOffsetY, setScrollOffsetY] = useState(0);

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
        backgroundColor: "rgba(0,0,0,0.4)",
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
        zIndex: 100,
      }}
      accessible={true}
      accessibilityLabel="Custom window"
    >
      <View
        style={{
          backgroundColor: "#fff",
          borderRadius: 12,
          padding: 16,
          width: "100%",
          maxWidth: 400,
          flex: 1,
          gap: 12,
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
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 12,
            flexShrink: 0,
            backgroundColor: "#fff",
            paddingBottom: 8,
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
          <View style={{ flexDirection: "row", gap: 8 }}>
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
