import { useEffect, useState, type ReactElement } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { RecheckResult, ResultGroup, ScheduleSkeletonEntry } from "@seatfirst/core";
import type { RowProvenance } from "@/hooks/viewModels/useSearchResultsViewModel";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { SecondaryButton } from "@/components/core/Button";
import { ShowtimeRow } from "./ShowtimeRow";
import { applyPreferOrder, NO_PREFERENCE, type PreferToggles } from "@/lib/preferSort";
import { SeatDot } from "@/components/core/SeatDot";
export const BATCH_SIZE = 20;

export interface ShowtimeListProps {
  skeleton: ScheduleSkeletonEntry[];
  groups: ResultGroup[];
  partySize: number;
  resolved: number;
  total: number;
  searchStatus?: string | null;
  terminalCause?: string | null;
  /** Finding #10: search reached any terminal outcome — threaded to rows so unresolved admitted rows stop pulsing. */
  isTerminal?: boolean;
  onCheckMore?: (() => void) | undefined;
  /** Terminal zero-result empty state: surfaces the screen's existing edit affordance (backToSearch). */
  onEditSearch?: (() => void) | undefined;
  handoffEligible?: string[] | undefined;
  onHandoff?: ((showtimeId: string) => void) | undefined;
  /** UI30 (ADR 0063 §3): showtime with a recheck in flight — other rows disable. */
  recheckingShowtimeId?: string | null;
  /** UI30: showtime the latest recheck result/error belongs to. */
  recheckSelectedShowtimeId?: string | null;
  /** UI30 (ADR 0063 §5-6): latest recheck result, shown on its target row only. */
  recheckResult?: RecheckResult | null;
  /** UI30 (ADR 0063 §6): canonical inline error copy for the target row, if any. */
  recheckError?: string | null;
  /** Dismisses the target row's inline recheck result/error. */
  onClearRecheck?: (() => void) | undefined;
  toggles?: PreferToggles;
  placeholderCount?: number | null;
  theaterName?: string;
  theatreNameById?: Map<string, string>;
  compact?: boolean;
  /** UI31 (ADR 0064): per-showtime provenance for the in-situ diff-merge window. */
  provenanceByShowtimeId?: Map<string, RowProvenance>;
}

function headerCopy(resolved: number, total: number, _hitCount: number, partySize: number): string {
  if (total === 0) return "Finding showtimes…";
  if (resolved < total) {
    return `${resolved} of ${total} checked · ${partySize} together`;
  }
  return `${resolved} of ${total} checked`;
}

export function isHit(entry: ScheduleSkeletonEntry, groups: ResultGroup[]): boolean {
  if (!entry.admitted || !entry.resolved) return false;
  const g = groups.find((grp) => grp.showtimes.some((s) => s.showtimeId === entry.showtimeId));
  if (!g) return false;
  const idx = g.showtimes.findIndex((s) => s.showtimeId === entry.showtimeId);
  return (g.groupHits ?? []).some((h) => h.showtimeIndices.includes(idx));
}

function isResolvedMiss(entry: ScheduleSkeletonEntry, groups: ResultGroup[]): boolean {
  if (!entry.admitted || !entry.resolved) return false;
  return !isHit(entry, groups);
}
export function ShowtimeList({
  skeleton,
  groups,
  partySize,
  resolved,
  total,
  searchStatus,
  terminalCause,
  isTerminal = false,
  onCheckMore,
  onEditSearch,
  handoffEligible,
  onHandoff,
  recheckingShowtimeId = null,
  recheckSelectedShowtimeId = null,
  recheckResult = null,
  recheckError = null,
  onClearRecheck,
  toggles = NO_PREFERENCE,
  placeholderCount = null,
  theaterName = "",
  theatreNameById,
  compact = false,
  provenanceByShowtimeId,
}: ShowtimeListProps): ReactElement {
  const [showMisses, setShowMisses] = useState(false);
  const firstShowtimeId = skeleton[0]?.showtimeId;

  useEffect(() => {
    setShowMisses(false);
  }, [firstShowtimeId]);
  const hitCount = skeleton.filter((e) => isHit(e, groups)).length;
  const missCount = skeleton.filter((e) => isResolvedMiss(e, groups)).length;
  // Generic non-authoritative placeholders while preview is in flight and before
  // server-authoritative skeleton arrives. Never fabricate ScheduleSkeletonEntry.
  if (skeleton.length === 0) {
    // Terminal with zero rows (e.g. HALTED with no showtimes): the search will
    // never produce rows, so skeletons must stop — render an actionable empty
    // state instead of pulsing "Checking seats…" forever with no way to retry.
    if (isTerminal || searchStatus === "HALTED") {
      return (
        <View style={styles.container} testID="empty-search-state">
          <View style={styles.banner}>
            <AppText weight="400" style={styles.bannerText}>
              No showtimes found for these dates/format. Try adjusting your window or format.
            </AppText>
            {onEditSearch ? (
              <SecondaryButton
                label="Edit search"
                onPress={onEditSearch}
                accessibilityHint="Returns to search form"
              />
            ) : null}
          </View>
        </View>
      );
    }
    if (placeholderCount !== null && placeholderCount > 0) {
      return (
        <View style={styles.container} testID="placeholder-skeleton">
          <AppText weight="600" style={styles.header}>
            {headerCopy(resolved, placeholderCount, 0, partySize)}
          </AppText>
          <View style={styles.list}>
            {Array.from({ length: placeholderCount }, (_, i) => (
              <View key={`ph-${i}`} style={styles.placeholderRow} testID="placeholder-row">
                <AppText weight="400" style={styles.placeholderText}>
                  Checking seats…
                </AppText>
              </View>
            ))}
          </View>
        </View>
      );
    }
    // ADR 0054 (Rec 2.2): browse-time counts are only available when the theatre
    // movie set is complete, so a cold/in-flight browse leaves placeholderCount null.
    // Never first-paint blank — fall back to a default set of placeholder rows in
    // the same pattern while the first skeleton/group event is still in flight.
    if (placeholderCount === null) {
      return (
        <View style={styles.container} testID="placeholder-skeleton">
          <AppText weight="600" style={styles.header}>
            {headerCopy(resolved, 0, 0, partySize)}
          </AppText>
          <View style={styles.list}>
            {Array.from({ length: 4 }, (_, i) => (
              <View key={`ph-fallback-${i}`} style={styles.placeholderRow} testID="placeholder-row">
                <AppText weight="400" style={styles.placeholderText}>
                  Checking seats…
                </AppText>
              </View>
            ))}
          </View>
        </View>
      );
    }
    return <View />;
  }

  const showDeferredGroup = skeleton.some((e) => !e.admitted);
  const showCheckMore = terminalCause === "BATCH_DEFERRED" && typeof onCheckMore === "function";

  const nothingFitsNothingDeferred =
    total > 0 &&
    resolved === total &&
    terminalCause !== "BATCH_DEFERRED" &&
    hitCount === 0 &&
    skeleton.every((e) => e.admitted);

  const ordered = applyPreferOrder(skeleton, groups, partySize, toggles ?? NO_PREFERENCE);
  const visibleOrdered = ordered.filter(
    (entry) => showMisses || hitCount === 0 || !isResolvedMiss(entry, groups),
  );

  let topPickId: string | null = null;
  if (hitCount > 0) {
    let bestRank = Infinity;
    for (const e of skeleton) {
      if (isHit(e, groups) && e.rank < bestRank) {
        bestRank = e.rank;
        topPickId = e.showtimeId;
      }
    }
  }

  // UI17's narrow ADR 0041 amendment: resolved misses default behind an honest,
  // one-tap disclosure when at least one hit exists. Pending/deferred rows stay visible.
  const hasAdmittedRow = skeleton.some((e) => e.admitted);

  const unchecked = total - resolved;

  // Halted-search row status (2026-09-03 decision): a HALTED search stopped by the
  // capacity limit never resolves its remaining admitted rows — they must not pulse
  // "Checking seats" forever. terminalCause "CAPACITY" is only set on such halts.
  const haltedCapacity = searchStatus === "HALTED" && terminalCause === "CAPACITY";
  return (
    <View style={styles.container}>
      {showCheckMore ? (
        <View style={styles.banner} testID="continuation-banner">
          <AppText weight="400" style={styles.bannerText}>
            {`${unchecked} showtimes in this search are still unchecked.`}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Check ${Math.min(BATCH_SIZE, unchecked)} more`}
            onPress={onCheckMore}
          >
            <AppText weight="700" style={styles.bannerAction}>
              {`Check ${Math.min(BATCH_SIZE, unchecked)} more`}
            </AppText>
          </Pressable>
        </View>
      ) : null}

      {hasAdmittedRow ? (
        <View style={styles.sectionHeaderWrap}>
          <AppText weight="700" style={styles.sectionHeader}>
            EVERY SHOWTIME THAT FITS
          </AppText>
          <View style={styles.legend} testID="legend">
            <View style={styles.legendItem}>
              <View style={styles.freeDot} />
              <AppText weight="400" style={styles.legendText}>
                Free
              </AppText>
            </View>
            <View style={styles.legendItem}>
              <View style={styles.takenDot} />
              <AppText weight="400" style={styles.legendText}>
                Taken
              </AppText>
            </View>
            <View style={styles.legendItem}>
              <SeatDot active hue="amber" size={8} />
              <AppText weight="400" style={styles.legendText}>
                {`Your ${partySize}`}
              </AppText>
            </View>
          </View>
        </View>
      ) : null}

      <View style={styles.list}>
        {visibleOrdered.map((entry) => {
          // UI30 (ADR 0063 §3/§5-6): exactly one row owns the flight/result/error —
          // the targeted row renders inline states, every other row just disables.
          const isTargetRow =
            recheckSelectedShowtimeId !== null && recheckSelectedShowtimeId === entry.showtimeId;
          return (
            <ShowtimeRow
              key={entry.showtimeId}
              entry={entry}
              groups={groups}
              partySize={partySize}
              resolvedCount={resolved}
              onHandoff={onHandoff}
              handoffEligible={handoffEligible}
              isTopPick={entry.showtimeId === topPickId}
              theaterName={theatreNameById?.get(entry.theatreId) ?? theaterName}
              compact={compact}
              halted={haltedCapacity}
              isTerminal={isTerminal}
              isRechecking={
                recheckingShowtimeId !== null && recheckingShowtimeId === entry.showtimeId
              }
              isOtherRechecking={
                recheckingShowtimeId !== null && recheckingShowtimeId !== entry.showtimeId
              }
              recheckResult={isTargetRow ? recheckResult : null}
              recheckError={isTargetRow ? recheckError : null}
              onClearRecheck={onClearRecheck}
              provenance={provenanceByShowtimeId?.get(entry.showtimeId) ?? "RESOLVED_CURRENT"}
            />
          );
        })}
      </View>

      {hitCount > 0 && missCount > 0 ? (
        <Pressable
          style={styles.missToggleWrap}
          accessibilityRole="button"
          accessibilityLabel={
            showMisses
              ? `Hide the ${missCount} that didn't fit`
              : `${missCount} didn't fit · show them`
          }
          onPress={() => setShowMisses((visible) => !visible)}
          testID="miss-toggle"
        >
          <AppText weight="600" style={styles.missToggleText}>
            {showMisses
              ? `Hide the ${missCount} that didn't fit`
              : `${missCount} didn't fit · show them`}
          </AppText>
        </Pressable>
      ) : null}
      {showDeferredGroup ? (
        <AppText weight="400" style={styles.deferredNote}>
          Deferred showtimes will be checked on request
        </AppText>
      ) : null}

      {nothingFitsNothingDeferred ? (
        <AppText weight="400" style={styles.emptyNote}>
          {`None of the ${partySize} seat${partySize === 1 ? "" : "s"} together — drop contiguous, or save this search`}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  header: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  sectionHeaderWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  sectionHeader: {
    fontSize: 11,
    color: colors.textTertiary,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  legend: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  legendItem: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
  },
  legendText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  takenDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.seatTaken,
  },
  list: {
    gap: 10,
    marginTop: 2,
  },
  missToggleWrap: {
    alignSelf: "flex-start",
    paddingVertical: 10,
  },
  missToggleText: {
    fontSize: 14,
    color: colors.brandDark,
  },
  deferredNote: {
    fontSize: 12,
    color: colors.textTertiary,
    fontStyle: "italic",
  },
  banner: {
    marginTop: 6,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: colors.theaterConfirmBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.brand,
    borderStyle: "dashed",
  },
  bannerText: {
    fontSize: 15,
    color: colors.textPrimary,
  },
  bannerAction: {
    fontSize: 15,
    color: colors.brandDark,
    textDecorationLine: "underline",
  },
  freeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.mapEmptyEnd,
    backgroundColor: colors.cardBg,
  },
  emptyNote: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 4,
  },
  placeholderRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.cardBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.ghostDashed,
  },
  placeholderText: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
