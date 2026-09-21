import type { ReactElement } from "react";
import { View, Pressable } from "react-native";
import { AppText } from "@/components/core/AppText";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { Sheet } from "@/components/core/Sheet";
import { CustomDateCalendar } from "./CustomDateCalendar";
import { useWhenCustomSheetViewModel } from "@/hooks/viewModels/useWhenCustomSheetViewModel";
import { ChipRow } from "./ChipRow";
import { MOVIE_BROWSE_SPAN_DAYS } from "@/lib/dates";

export function WhenCustomSheet({ isMobile }: { isMobile?: boolean } = {}): ReactElement | null {
  const desktop = isMobile === false;
  const vm = useWhenCustomSheetViewModel();
  if (!vm.whenSheetOpen) return null;

  return (
    <Sheet
      open={vm.whenSheetOpen}
      onClose={vm.actions.handleCancel}
      ariaLabel="Custom window"
      maxWidth={400}
    >
      <Sheet.Header
        title="Custom window"
        subtitle="Pick any dates in the next 30 days."
        onClose={vm.actions.handleCancel}
      />
      <Sheet.Body>
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
      </Sheet.Body>
      <Sheet.Footer>
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
      </Sheet.Footer>
    </Sheet>
  );
}
