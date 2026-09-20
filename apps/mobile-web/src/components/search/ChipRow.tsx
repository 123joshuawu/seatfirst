import type { ReactElement, ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import type { ChipItem } from "@/types/ui";
import { Chip } from "@/components/core/Chip";
import { AppText } from "@/components/core/AppText";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { colors } from "@/theme/colors";
import { getFacetDisplay, shouldDimFacet } from "@/lib/facetCounts";
import type { FacetCountEntry } from "@/lib/facetCounts";
import { timeOfDayBounds } from "@/lib/buildSearchSpec";
import { formatClockTime12h } from "@/lib/dates";
export interface ChipRowProps {
  label: string;
  chips: ChipItem[];
  shape?: "pill" | "square";
  checkbox?: boolean;
  /** Optional secondary line under the label, e.g. the seat-preference description. */
  description?: ReactNode;
  marginBottom?: number;
  labelSuffix?: ReactNode;
  isLocked?: boolean;
  /** Per-chip disabled when radius chips disabled by no-guess gate (hasWhereSelection false). */
  disabled?: boolean;
  /** Tri-state facet counts (UI18.6) — Map keyed by candidate id or chip label. */
  facetCounts?: Map<string, FacetCountEntry> | Record<string, FacetCountEntry> | undefined;
  /** Total theatres in the facet request — needed to distinguish not-checked-yet vs n+. */
  totalTheatres?: number | undefined;
  getFacetKey?: (chip: ChipItem, index: number) => string | undefined;
  /**
   * Desktop override — when explicitly `false`, renders the same row with
   * tighter vertical rhythm (label margin) so the form CTA clears ~900px
   * viewports. `undefined` keeps the long-standing mobile values.
   */
  isMobile?: boolean;
  /**
   * UX-04: on mobile, lay pills out in a balanced 2-up grid (each chip
   * `flexBasis: "48%"` + `flexGrow: 1` inside the wrapping row) so a 4-chip
   * row settles into two full rows instead of stranding one pill alone.
   * Desktop layout untouched. Opt-in per caller.
   */
  balancedGridMobile?: boolean;
}

export function ChipRow({
  label,
  chips,
  shape = "pill",
  checkbox = false,
  description,
  marginBottom = 20,
  labelSuffix,
  isLocked = false,
  disabled = false,
  facetCounts,
  totalTheatres,
  getFacetKey,
  isMobile,
  balancedGridMobile = false,
}: ChipRowProps): ReactElement {
  const groupDisabled = isLocked || disabled;
  const desktop = isMobile === false;
  const grid = balancedGridMobile && !desktop;
  const facetMap: Map<string, FacetCountEntry> | null = (() => {
    if (!facetCounts) return null;
    if (facetCounts instanceof Map) return facetCounts;
    return new Map(Object.entries(facetCounts));
  })();
  const total = totalTheatres ?? (facetMap ? facetMap.size : 0);
  const isSquare = shape === "square";
  const isDChip = label === "Dates" || label === "Time of day";
  const isTimeDChip = label === "Time of day";
  return (
    <View style={{ marginBottom }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <EyebrowLabel marginBottom={isMobile === false ? 6 : 8}>{label}</EyebrowLabel>
        {labelSuffix}
      </View>
      {description}
      <View
        style={
          isSquare
            ? { flexDirection: "row", gap: 8 }
            : { flexDirection: "row", flexWrap: "wrap", gap: 8 }
        }
        {...(Platform.OS === "web"
          ? ({ role: "group", "aria-label": label } as unknown as Record<string, unknown>)
          : {})}
      >
        {chips.map((chip, i) => {
          // Resolve facet entry for this chip (tri-state counts). `getFacetKey` returning
          // `undefined` for a specific chip (e.g. "Any time") opts that chip out of facet
          // display entirely — distinct from a key that simply has no map entry yet, which
          // getFacetDisplay reports as "not checked yet".
          let entry: FacetCountEntry | undefined;
          let participatesInFacets = false;
          if (facetMap) {
            const maybeKey = getFacetKey ? getFacetKey(chip, i) : chip.label;
            if (maybeKey !== undefined) {
              participatesInFacets = true;
              const rawKey = maybeKey;
              // Try direct, lower-case, and stripped label (remove old " · count" or
              // current " (count)" suffix if present, for backward compatibility)
              const baseLabel =
                (rawKey.split("·")[0] ?? rawKey).split(" (")[0]?.trim() ?? rawKey.trim();
              entry =
                facetMap.get(rawKey) ??
                facetMap.get(baseLabel) ??
                facetMap.get(baseLabel.toLowerCase()) ??
                facetMap.get(rawKey.toLowerCase());
            }
          }
          const display = participatesInFacets ? getFacetDisplay(entry, total) : null;
          const shouldDim = shouldDimFacet(entry, total);
          // Only warm zero dims+disables; cold/partial zero stays selectable (UI18.6)
          const isDisabled = groupDisabled || shouldDim;
          // A dense chip grid (Format, Dates, Time-of-day) repeats "not checked yet" once per
          // chip, which reads as noisy filler rather than useful feedback (Amendment
          // 2026-09-02, ADR 0044 §4). Cold chips render bare — same as an opted-out chip —
          // while warm/partial counts still show. Single-row list contexts (MovieField,
          // TheaterField) are untouched; they render the literal text directly, not via
          // ChipRow, where it isn't repetitive.
          const chipLabel =
            display && !display.isNotCheckedYet
              ? `${((chip.label.split("·")[0] ?? chip.label).split(" (")[0] ?? chip.label).trim()} (${display.text})`
              : chip.label;
          if (isSquare) {
            return (
              <Pressable
                key={i}
                onPress={isDisabled ? undefined : chip.onPress}
                disabled={isDisabled}
                accessibilityRole={checkbox ? "checkbox" : "button"}
                accessibilityLabel={chipLabel}
                accessibilityState={
                  checkbox
                    ? { checked: chip.active, disabled: !!isDisabled }
                    : { selected: chip.active, disabled: !!isDisabled }
                }
                focusable={!isDisabled}
                style={[
                  styles.squareDChip,
                  desktop && styles.squareDChipDesktop,
                  chip.active ? styles.activeBase : styles.inactiveBase,
                  isDisabled && styles.disabled,
                ]}
              >
                <AppText
                  weight={chip.active ? "700" : "600"}
                  style={{
                    fontSize: 14,
                    color: chip.active ? colors.amberTagText : colors.textPrimary,
                  }}
                >
                  {chipLabel}
                </AppText>
              </Pressable>
            );
          }
          if (isDChip) {
            const hrs: string | null = (() => {
              if (!isTimeDChip) return null;
              if (chip.label === "Any time") return null;
              try {
                const b = timeOfDayBounds(chip.label);
                // Only show hrs if bounds are not the generic Any-time fallback and data exists
                if (b.startLocal === "00:00" && b.endLocal === "23:59" && chip.label !== "Any time")
                  return null;
                return `${formatClockTime12h(b.startLocal)}–${formatClockTime12h(b.endLocal)}`;
              } catch {
                return null;
              }
            })();
            return (
              <Pressable
                key={i}
                onPress={isDisabled ? undefined : chip.onPress}
                disabled={isDisabled}
                accessibilityRole={checkbox ? "checkbox" : "button"}
                accessibilityLabel={hrs ? `${chipLabel}, ${hrs}` : chipLabel}
                accessibilityState={
                  checkbox
                    ? { checked: chip.active, disabled: !!isDisabled }
                    : { selected: chip.active, disabled: !!isDisabled }
                }
                focusable={!isDisabled}
                style={[
                  styles.dChipBase,
                  chip.active ? styles.activeBase : styles.inactiveBase,
                  isDisabled && styles.disabled,
                ]}
              >
                {checkbox ? (
                  <View
                    style={[styles.checkbox, chip.active ? styles.checkboxOn : styles.checkboxOff]}
                    accessible={false}
                    importantForAccessibility="no"
                  >
                    {chip.active ? (
                      <AppText weight="700" style={styles.checkboxGlyph}>
                        ✓
                      </AppText>
                    ) : null}
                  </View>
                ) : null}
                <View style={{ gap: 1 }}>
                  <AppText
                    weight={chip.active ? "600" : "500"}
                    style={{
                      fontSize: 13,
                      color: chip.active ? colors.amberTagText : colors.textPrimary,
                    }}
                  >
                    {chipLabel}
                  </AppText>
                  {hrs ? (
                    <AppText weight="400" style={styles.hrs}>
                      {hrs}
                    </AppText>
                  ) : null}
                </View>
              </Pressable>
            );
          }
          const pill = (
            <Chip
              key={i}
              label={chipLabel}
              active={chip.active}
              onPress={isDisabled ? () => {} : chip.onPress}
              shape={shape}
              checkbox={checkbox}
              disabled={isDisabled}
            />
          );
          // UX-04: grid cell wrapper only on mobile opt-in; desktop keeps bare chips.
          if (grid) {
            return (
              <View key={i} style={styles.gridCell}>
                {pill}
              </View>
            );
          }
          return pill;
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  squareDChip: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 11,
    paddingHorizontal: 0,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  // Desktop (≥680px): slightly shorter seat-count buttons; still well above
  // mouse-target minimums, and touch devices use the mobile values.
  squareDChipDesktop: {
    minHeight: 40,
    paddingVertical: 9,
  },
  dChipBase: {
    paddingVertical: 6,
    paddingHorizontal: 11,
    borderRadius: 8,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  activeBase: {
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
  },
  inactiveBase: {
    borderColor: colors.borderStrong,
    backgroundColor: colors.cardMutedBg,
  },
  disabled: {
    opacity: 0.5,
  },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: colors.brandDark,
  },
  checkboxOff: {
    borderWidth: 1.5,
    borderColor: colors.checkboxOffBorder,
  },
  checkboxGlyph: {
    fontSize: 10,
    lineHeight: 10,
    color: colors.white,
  },
  hrs: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  // UX-04: mobile 2-up grid cell for opted-in pill rows (Format).
  gridCell: {
    flexBasis: "48%",
    flexGrow: 1,
  },
});
