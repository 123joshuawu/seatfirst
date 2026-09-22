import { useState, type ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { Animated } from "react-native";
import type {
  Placement,
  RecheckResult,
  RecommendationReason,
  ResultGroup,
  ScheduleSkeletonEntry,
} from "@seatfirst/core";
import { colors } from "@/theme/colors";
import { usePulseOpacity } from "@/theme/animations";
import { AppText } from "@/components/core/AppText";
import { Badge } from "@/components/core/Badge";
import { PrimaryButton, SecondaryButton } from "@/components/core/Button";
import { SeatDotGrid } from "@/components/core/SeatDotGrid";
import { formatCodeToPref } from "@/lib/buildSearchSpec";
import {
  buildRowDotGrid,
  formatFreshnessInfo,
  freeAndTotalSeats,
  summarizePlacement,
} from "@/lib/rowSummary";
import { distanceLabel, priceLabel } from "@/lib/presentation";
import { openHandoff, resolveDeepLinkForShowtime } from "@/lib/handoff";
import type { RowProvenance } from "@/hooks/viewModels/useSearchResultsViewModel";

export interface ShowtimeRowProps {
  entry: ScheduleSkeletonEntry;
  groups: ResultGroup[];
  partySize: number;
  resolvedCount: number;
  onHandoff?: ((showtimeId: string) => void) | undefined;
  handoffEligible?: string[] | undefined;
  /** This fix: canonical answer-level placement per showtimeId (built in
   *  `useSearchResultsViewModel` from the ranked answer alone). When this
   *  row's showtime is covered here, the displayed seat/row text and dot-grid
   *  highlight come from the answer's own `placement` — the exact placement
   *  bound to the real nonce/recheck/deep-link — never from the (possibly
   *  stale, ADR 0064-retained) group's own top `groupHits[0]` pick. Absent
   *  entries keep today's `group.groupHits`-derived display. */
  answerPlacements?:
    Record<string, { placement: Placement; reasons: RecommendationReason[] }> | undefined;
  isTopPick?: boolean;
  theaterName?: string;
  halted?: boolean;
  /** Finding #10: search reached any terminal outcome — unresolved admitted rows render "Not checked" instead of pulsing "Checking seats". */
  isTerminal?: boolean;
  compact?: boolean;
  /** UI30 (ADR 0063 §3): this row's recheck is in flight — CTA shows a spinner. */
  isRechecking?: boolean;
  /** UI30 (ADR 0063 §3): another row is rechecking — this row's CTA is disabled. */
  isOtherRechecking?: boolean;
  /** UI30 (ADR 0063 §5-6): latest recheck result targeted at this row, if any. */
  recheckResult?: RecheckResult | null;
  /** UI30 (ADR 0063 §6): canonical inline error copy for this row, if any. */
  recheckError?: string | null;
  /** Dismisses this row's inline recheck result/error. */
  onClearRecheck?: (() => void) | undefined;
  /** UI41 (ADR 0071 §UI41.2): persistent taken state from the store — survives
   *  subsequent rechecks on other rows, unlike the flight-scoped recheckResult. */
  isTaken?: boolean;
  /** UI31 (ADR 0064): in-situ diff-merge provenance — retained rows gate the CTA. */
  provenance?: RowProvenance;
}

function formatShowtimeLocal(showDateTimeLocal: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(showDateTimeLocal);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    const localAsUtc = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
    );
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
      .format(localAsUtc)
      .replace(", at ", " · ")
      .replace(" at ", " · ")
      .replace(/, (?=\d{1,2}:\d{2}\s[AP]M$)/, " · ");
  }
  return showDateTimeLocal;
}

function formatLabel(formatCode: string | null): string {
  const preference = formatCodeToPref(formatCode);
  if (preference === "imax") return "IMAX";
  if (preference === "dolby") return "Dolby Cinema";
  return "Standard";
}

/**
 * S62 (ADR 0067): curated screening-attribute tags for seating/accessibility.
 * Unknown codes are ignored (never raw pass-through); format codes are never
 * tagged here — `formatLabel(entry.formatCode)` already owns the format badge.
 * Heated recliners takes precedence: never show both "Heated Recliners" and
 * "Recliners" for the same card.
 */
function screeningAttributeTags(
  attributes: readonly string[],
  formatCode: string | null,
): string[] {
  const codes = new Set(attributes.map((code) => code.toLowerCase()));
  const format = (formatCode ?? "").toLowerCase();
  if (format.length > 0) codes.delete(format);
  const tags: string[] = [];
  if (codes.has("heatedseats")) {
    tags.push("Heated Recliners");
  } else if (codes.has("reclinerseating") || codes.has("plushrecliners")) {
    tags.push("Recliners");
  }
  if (codes.has("opencaption")) tags.push("Open Caption");
  return tags;
}

function findGroupForShowtime(showtimeId: string, groups: ResultGroup[]): ResultGroup | undefined {
  return groups.find((g) => g.showtimes.some((s) => s.showtimeId === showtimeId));
}

function deriveStatusText(
  entry: ScheduleSkeletonEntry,
  groups: ResultGroup[],
  partySize: number,
  resolvedCount: number,
  halted: boolean = false,
  isTerminal: boolean = false,
): {
  text: string;
  variant: "deferred" | "checking" | "queued" | "hit" | "miss" | "failed" | "halted";
} {
  if (!entry.admitted) {
    return { text: "Deferred — not yet requested", variant: "deferred" };
  }
  if (!entry.resolved) {
    if (entry.fetchStatus === "FAILED") {
      return { text: "Seating chart unavailable", variant: "failed" };
    }
    if (halted) {
      return { text: "Not checked (capacity limit)", variant: "halted" };
    }
    // Finding #10: any other terminal outcome (e.g. PARTIAL) also leaves
    // admitted rows unresolved forever — they must not pulse "Checking seats".
    // Reuses the muted non-pulsing "halted" variant (generic tertiary copy
    // styling, no capacity-specific visual cues) with generic wording.
    if (isTerminal) {
      return { text: "Not checked", variant: "halted" };
    }
    const isChecking = entry.rank < resolvedCount + 5;
    return {
      text: isChecking ? "Checking seats" : "Queued",
      variant: isChecking ? "checking" : "queued",
    };
  }
  const group = findGroupForShowtime(entry.showtimeId, groups);
  if (!group) {
    return { text: `No ${partySize} together`, variant: "miss" };
  }
  const showtimeIdx = group.showtimes.findIndex((s) => s.showtimeId === entry.showtimeId);
  const resolvedShowtime = group.showtimes[showtimeIdx];
  if (!resolvedShowtime || resolvedShowtime.resolved === false) {
    return { text: `No ${partySize} together`, variant: "miss" };
  }
  const hits = group.groupHits ?? [];
  const hitForThisShowtime = hits.filter((h) => h.showtimeIndices.includes(showtimeIdx));
  if (hitForThisShowtime.length === 0) {
    return { text: `No ${partySize} together`, variant: "miss" };
  }
  const best = hitForThisShowtime[0];
  if (!best) return { text: `No ${partySize} together`, variant: "miss" };
  const rowLetter = String.fromCharCode(65 + best.row);
  const blockLabel = `${hitForThisShowtime.length} block${hitForThisShowtime.length === 1 ? "" : "s"}`;
  const centre = group.columns / 2;
  const isCentre = Math.abs(best.startCol + 1 - centre) < 2;
  const side = isCentre ? "centre" : "house left";
  return { text: `${blockLabel} · best is Row ${rowLetter}, ${side}`, variant: "hit" };
}

/** Accessibility hint for the direct-handoff CTA (ADR 0063 §1 — never implies a hold). */
const HANDOFF_A11Y_HINT = "Confirms seat availability and opens showtime on AMC";

export function ShowtimeRow({
  entry,
  groups,
  partySize,
  resolvedCount,
  onHandoff,
  handoffEligible,
  answerPlacements,
  isTopPick = false,
  theaterName = "",
  halted = false,
  isTerminal = false,
  compact = false,
  isRechecking = false,
  isOtherRechecking = false,
  recheckResult = null,
  recheckError = null,
  onClearRecheck,
  isTaken = false,
  provenance = "RESOLVED_CURRENT",
}: ShowtimeRowProps): ReactElement {
  const { text, variant } = deriveStatusText(
    entry,
    groups,
    partySize,
    resolvedCount,
    halted,
    isTerminal,
  );
  const pulse = usePulseOpacity(2000);
  const showPulse = variant === "checking";

  const showtimeLabel = formatShowtimeLocal(entry.showDateTimeLocal);
  const formatDisplay = formatLabel(entry.formatCode);
  const proximityLabel = distanceLabel(entry.distanceKm);
  const subtitle = [theaterName, formatDisplay, proximityLabel].filter(Boolean).join(" · ");
  const attributeTags = screeningAttributeTags(entry.attributes ?? [], entry.formatCode);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  // UI41 (ADR 0071 §UI41.2): persistent taken state. `isTaken` comes from the
  // store's append-only `takenShowtimeIds` and survives subsequent rechecks on
  // other rows; `isGoneRow` covers the flight-scoped result before the store
  // catches up. Taken rows never render alternative-showtime markup — the
  // RecoverySheet owns that entirely.
  const isGoneRow = recheckResult !== null && recheckResult.status === "GONE";
  const isTakenRow = isTaken || isGoneRow;
  const rowAvailable = recheckResult !== null && recheckResult.status === "AVAILABLE";
  const effectiveVariant = isTakenRow ? "miss" : variant;
  const statusText = isTakenRow ? "Seats just taken" : text;

  const handleOpenAvailable = (): void => {
    const deepLinkUrl = resolveDeepLinkForShowtime(entry.showtimeId, groups);
    if (deepLinkUrl === null) {
      setHandoffError("Couldn't open AMC for this showtime — try again");
      return;
    }
    setHandoffError(null);
    void openHandoff(deepLinkUrl);
  };

  // UI30 (ADR 0063 §3): inline CTA states, rendered once in the always-visible
  // head area (the row itself is no longer clickable — only this CTA is).
  const renderHandoffCTA = (): ReactElement => {
    if (isRechecking) {
      return (
        <PrimaryButton
          label="Confirming seats…"
          onPress={() => onHandoff?.(entry.showtimeId)}
          loading
          disabled
          accessibilityHint="Confirming seat availability"
          size="compact"
          testID={`rechecking-collapsed-${entry.showtimeId}`}
        />
      );
    }
    // UI30 amendment: once this row's own recheck resolved AVAILABLE, keep
    // showing the same "Go to AMC" CTA (the availability is already stated by
    // the status text above) — just skip straight to the direct open instead
    // of re-running the recheck, since the seats were confirmed moments ago.
    if (rowAvailable) {
      return (
        <PrimaryButton
          label="Go to AMC"
          onPress={handleOpenAvailable}
          accessibilityHint={HANDOFF_A11Y_HINT}
          size="compact"
        />
      );
    }
    // UI41 (ADR 0071 §UI41.2): a taken row keeps a disabled "Go to AMC" CTA —
    // same muted convention as the other-rechecking state (opacity 0.5,
    // disabled, pointerEvents none). Alternatives live in the RecoverySheet.
    if (isTakenRow) {
      return (
        <View style={styles.mutedCTA} pointerEvents="none">
          <PrimaryButton
            label="Go to AMC"
            onPress={() => onHandoff?.(entry.showtimeId)}
            disabled
            accessibilityHint={HANDOFF_A11Y_HINT}
            size="compact"
          />
        </View>
      );
    }
    if (isOtherRechecking) {
      return (
        <View style={styles.mutedCTA} pointerEvents="none">
          <PrimaryButton
            label="Go to AMC"
            onPress={() => onHandoff?.(entry.showtimeId)}
            disabled
            accessibilityHint={HANDOFF_A11Y_HINT}
            size="compact"
          />
        </View>
      );
    }
    return (
      <PrimaryButton
        label="Go to AMC"
        onPress={() => onHandoff?.(entry.showtimeId)}
        accessibilityHint={HANDOFF_A11Y_HINT}
        size="compact"
      />
    );
  };

  const group = findGroupForShowtime(entry.showtimeId, groups);
  const showtimeIdx = group
    ? group.showtimes.findIndex((s) => s.showtimeId === entry.showtimeId)
    : -1;
  const resolvedShowtime =
    group && showtimeIdx >= 0
      ? (group.showtimes[showtimeIdx] as unknown as { capturedAt?: string; resolved: boolean })
      : null;
  const isResolvedShowtime = variant === "hit" || variant === "miss";
  // UI31.7 (ADR 0064 §1): coarse client-side narrowing signal — a resolved row
  // whose free-seat count no longer fits the party dims (visual only; the CTA
  // and handoff eligibility are unchanged).
  let insufficientForPartySize = false;
  if (isResolvedShowtime && group && showtimeIdx >= 0) {
    try {
      insufficientForPartySize = freeAndTotalSeats(group, showtimeIdx).free < partySize;
    } catch {
      insufficientForPartySize = false;
    }
  }

  let dotGrid: ReactElement | null = null;
  let placementLine: string | null = null;
  let highlightRange: { row: number; startCol: number; endCol: number } | null = null;

  if (isResolvedShowtime && group && showtimeIdx >= 0) {
    let grid: ReturnType<typeof buildRowDotGrid> | null;
    try {
      grid = buildRowDotGrid(group, showtimeIdx);
    } catch {
      grid = null;
    }
    // This fix: the canonical answer-level placement wins for DISPLAY whenever
    // this showtime is covered by the ranked answer. `groups` here is the
    // ADR 0064 `combinedGroups` union (live + retained for in-situ-merge visual
    // continuity), so `group` above can be a stale retained snapshot whose own
    // `groupHits[0]` pick no longer matches the placement actually bound to the
    // real nonce/recheck/deep-link (ADR 0041 §6 renders a working handoff CTA
    // for every hit, not just the primary's showtimes). The answer's own
    // `Recommendation.placement` is that canonical placement — display it,
    // never the group's own top hit. Only rows with no entry here fall back to
    // the `group.groupHits`-derived computation below, unchanged.
    const answerEntry = answerPlacements?.[entry.showtimeId];
    if (variant === "hit" && answerEntry !== undefined) {
      const canonical = answerEntry.placement;
      try {
        const summary = summarizePlacement(
          group,
          // summarizePlacement only reads `row`/`startCol` off the hit — the
          // group argument stays purely visual geometry (columns/rows/seatNames
          // for the label math), while the seat position itself is canonical.
          { row: canonical.row, startCol: canonical.startCol } as NonNullable<
            ResultGroup["groupHits"]
          >[number],
          partySize,
        );
        placementLine = `${summary.rowSeatLabel} · ${summary.centered ? "centered" : "off-centre"} · ${summary.third} third`;
      } catch {
        // Same local fallback as below, driven by the canonical placement.
        const rowLetter = String.fromCharCode(65 + canonical.row);
        const firstSeat = canonical.startCol + 1;
        const lastSeat = canonical.startCol + partySize;
        const seatLabel =
          firstSeat === lastSeat
            ? `Row ${rowLetter}, Seat ${firstSeat}`
            : `Row ${rowLetter}, Seats ${firstSeat}-${lastSeat}`;
        const cols = group.columns ?? 20;
        const rows = (group as unknown as { rows?: number }).rows ?? 10;
        const centred = Math.abs(canonical.startCol + partySize / 2 - cols / 2) < 2;
        const third =
          canonical.row < rows / 3 ? "front" : canonical.row < (2 * rows) / 3 ? "middle" : "back";
        placementLine = `${seatLabel} · ${centred ? "centered" : "off-centre"} · ${third} third`;
      }
      highlightRange = {
        row: canonical.row,
        startCol: canonical.startCol,
        endCol: canonical.startCol + partySize - 1,
      };
      // The grid is pure auditorium geometry, safe to visualize from whichever
      // group was found — but only when it actually depicts the canonical
      // placement's auditorium. A stale retained group from another layout
      // would highlight the right seats on the wrong map, so render no grid
      // rather than a mismatched one.
      if (grid && group.layoutId === canonical.layoutId) {
        dotGrid = <SeatDotGrid grid={grid} highlightedRange={highlightRange} />;
      }
    } else {
      if (variant === "hit") {
        const hits = (group.groupHits ?? []).filter((h) => h.showtimeIndices.includes(showtimeIdx));
        const best = hits[0];
        if (best) {
          try {
            const summary = summarizePlacement(group, best, partySize);
            placementLine = `${summary.rowSeatLabel} · ${summary.centered ? "centered" : "off-centre"} · ${summary.third} third`;
          } catch {
            const rowLetter = String.fromCharCode(65 + best.row);
            const firstSeat = best.startCol + 1;
            const lastSeat = best.startCol + partySize;
            const seatLabel =
              firstSeat === lastSeat
                ? `Row ${rowLetter}, Seat ${firstSeat}`
                : `Row ${rowLetter}, Seats ${firstSeat}-${lastSeat}`;
            const cols = group.columns ?? 20;
            const rows = (group as unknown as { rows?: number }).rows ?? 10;
            const centred = Math.abs(best.startCol + partySize / 2 - cols / 2) < 2;
            const third =
              best.row < rows / 3 ? "front" : best.row < (2 * rows) / 3 ? "middle" : "back";
            placementLine = `${seatLabel} · ${centred ? "centered" : "off-centre"} · ${third} third`;
          }
          highlightRange = {
            row: best.row,
            startCol: best.startCol,
            endCol: best.startCol + partySize - 1,
          };
        }
      }
      if (grid) {
        dotGrid = <SeatDotGrid grid={grid} highlightedRange={highlightRange} />;
      }
    }
  }

  const handoffAllowed =
    effectiveVariant === "hit" &&
    !!onHandoff &&
    provenance !== "RETAINED_DISPLAY_ONLY" &&
    (handoffEligible ?? []).includes(entry.showtimeId);
  // UI31 (ADR 0064): a retained hit row would otherwise show the normal hit CTA —
  // render a disabled "Updating…" CTA in its place until it resolves or drops out.
  const showUpdatingCta =
    provenance === "RETAINED_DISPLAY_ONLY" && effectiveVariant === "hit" && !!onHandoff;
  // UI41 (ADR 0071 §UI41.2): a taken row keeps its disabled CTA visible (the
  // RecoverySheet owns the alternatives — the row itself never expands).
  const showTakenCta = isTakenRow && !!onHandoff;

  // S59 (ADR 0062 §5, amending ADR 0041 decision 1): price badge on every resolved
  // hit row via priceLabel — formatted amount when present, "Price unavailable"
  // when null. Gated on hit status, not handoff eligibility: the legacy block nested
  // this inside handoffAllowed, hiding prices on hit rows whose Hold action is
  // ineligible (handoffAllowed still gates the Hold button below, per ADR 0041
  // decision 2 — that gating is unrelated and unchanged).
  let priceLine: string | null = null;
  if (effectiveVariant === "hit" && group && showtimeIdx >= 0) {
    priceLine = priceLabel(group.showtimes[showtimeIdx]?.minPrice ?? null);
  }

  // "Checked X ago" freshness reads as always-visible tertiary text (upper-right of
  // the row, above the price) rather than behind the removed expand-to-reveal toggle;
  // auditorium number and free-seat count were dropped along with that toggle.
  let freshnessLabel: string | null = null;
  let freshnessTier: "fresh" | "cached" | "stale" | null = null;
  if (variant === "hit" && group && showtimeIdx >= 0) {
    const capturedAt = (resolvedShowtime as unknown as { capturedAt?: string })?.capturedAt;
    const freshness = formatFreshnessInfo(capturedAt);
    freshnessLabel = freshness?.label ?? null;
    freshnessTier = freshness?.tier ?? null;
  }

  const headContent = (
    <View style={[styles.summaryRow, compact ? styles.summaryRowCompact : null]}>
      <View style={[styles.gridColumn, compact ? styles.gridColumnCompact : null]}>
        {dotGrid ? <View style={styles.gridWrap}>{dotGrid}</View> : null}
      </View>

      <View style={styles.detailsColumn}>
        <View style={styles.titleRow}>
          <AppText family="display" weight="600" style={styles.timeText}>
            {showtimeLabel}
          </AppText>
          {isTopPick ? (
            <View style={styles.topPickBadge}>
              <AppText weight="700" style={styles.topPickBadgeText}>
                TOP PICK
              </AppText>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <AppText weight="400" style={styles.subtitleText}>
            {subtitle}
          </AppText>
        ) : null}
        {attributeTags.length > 0 ? (
          <View style={styles.attributeBadgeRow}>
            {attributeTags.map((tag) => (
              <Badge
                key={tag}
                label={tag}
                background={colors.amberTagBg}
                color={colors.amberTagTextContrast}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.statusWrap}>
          {effectiveVariant === "hit" && placementLine ? (
            <AppText weight="400" style={styles.placementText}>
              {placementLine}
            </AppText>
          ) : effectiveVariant === "hit" ? (
            <Badge
              label={text}
              background={colors.amberTagBg}
              color={colors.amberTagTextContrast}
            />
          ) : effectiveVariant === "miss" ? (
            <AppText weight="400" style={styles.missText}>
              {statusText}
            </AppText>
          ) : variant === "deferred" ? (
            <AppText weight="400" style={styles.deferredText}>
              {text}
            </AppText>
          ) : variant === "failed" ? (
            <AppText weight="400" style={styles.failedText}>
              {text}
            </AppText>
          ) : variant === "halted" ? (
            <AppText weight="400" style={styles.haltedText}>
              {text}
            </AppText>
          ) : showPulse ? (
            <Animated.View style={{ opacity: pulse }}>
              <AppText weight="400" style={styles.checkingText}>
                {text}
              </AppText>
            </Animated.View>
          ) : (
            <AppText weight="400" style={styles.queuedText}>
              {text}
            </AppText>
          )}
        </View>
      </View>
    </View>
  );

  return (
    <View
      style={[
        styles.card,
        effectiveVariant === "miss" ? styles.missCard : null,
        insufficientForPartySize && effectiveVariant !== "miss" ? styles.dimmedRow : null,
      ]}
      testID={`showtime-row-${entry.showtimeId}`}
    >
      <View style={[styles.cardMain, compact ? styles.cardMainCompact : null]}>
        <View style={styles.expandTarget}>{headContent}</View>

        {handoffAllowed || showUpdatingCta || showTakenCta || priceLine || freshnessLabel ? (
          <View style={[styles.handoffWrap, compact ? styles.handoffWrapCompact : null]}>
            {freshnessLabel ? (
              <AppText
                weight="400"
                style={freshnessTier === "stale" ? styles.freshnessTextStale : styles.freshnessText}
                testID={`freshness-${entry.showtimeId}`}
              >
                {freshnessLabel}
              </AppText>
            ) : null}
            {priceLine ? (
              <AppText weight="400" style={styles.priceText}>
                {priceLine}
              </AppText>
            ) : null}
            {handoffAllowed || showTakenCta ? (
              renderHandoffCTA()
            ) : showUpdatingCta ? (
              <PrimaryButton
                label="Updating…"
                onPress={() => {}}
                disabled
                size="compact"
                accessibilityHint="This result is being refreshed"
              />
            ) : null}
            {rowAvailable && handoffError ? (
              <AppText
                weight="400"
                style={styles.handoffErrorText}
                testID={`handoff-error-${entry.showtimeId}`}
              >
                {handoffError}
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>

      {recheckError ? (
        <View style={styles.errorCallout} testID={`recheck-error-${entry.showtimeId}`}>
          <AppText weight="400" style={styles.errorText}>
            {recheckError}
          </AppText>
          <View style={styles.errorActions}>
            <SecondaryButton label="Retry" onPress={() => onHandoff?.(entry.showtimeId)} />
            <SecondaryButton label="Dismiss" onPress={() => onClearRecheck?.()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderHairline,
    paddingVertical: 15,
    paddingHorizontal: 18,
    gap: 14,
    shadowColor: colors.popoverShadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 10,
    elevation: 2,
  },
  missCard: {
    opacity: 0.52,
  },
  // UI31.7 (ADR 0064 §1): coarse party-size narrowing — same muted convention as
  // mutedCTA below. Applied to the outer row only; miss rows keep missCard.
  dimmedRow: {
    opacity: 0.5,
  },
  cardMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 18,
  },
  cardMainCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 14,
  },
  expandTarget: {
    flexGrow: 1,
    flexShrink: 1,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
  },
  summaryRowCompact: {
    alignItems: "flex-start",
    gap: 16,
  },
  gridColumn: {
    width: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingTop: 3,
  },
  gridColumnCompact: {
    width: 120,
  },
  detailsColumn: {
    flexGrow: 1,
    flexShrink: 1,
    gap: 5,
  },
  titleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
  },
  timeText: {
    fontSize: 15,
    color: colors.textPrimary,
  },
  subtitleText: {
    fontSize: 13.5,
    color: colors.textMuted,
  },
  attributeBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  occupancyText: {
    fontSize: 9.5,
    color: colors.textTertiary,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: 0.19,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  gridWrap: {
    minHeight: 34,
    justifyContent: "center",
  },
  statusWrap: {
    minHeight: 20,
  },
  placementText: {
    fontSize: 13.5,
    color: colors.statusGreen,
  },
  missText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  deferredText: {
    fontSize: 12,
    color: colors.textTertiary,
    fontStyle: "italic",
  },
  failedText: {
    fontSize: 12,
    color: colors.textTertiary,
    fontStyle: "italic",
  },
  checkingText: {
    fontSize: 12,
    color: colors.brandDark,
  },
  queuedText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  haltedText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  topPickBadge: {
    backgroundColor: colors.amberTagBg,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
    marginLeft: 10,
  },
  topPickBadgeText: {
    fontSize: 10,
    color: colors.amberTagTextContrast,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  handoffWrap: {
    flexShrink: 0,
    alignItems: "flex-end",
    gap: 7,
  },
  handoffWrapCompact: {
    width: "100%",
    alignItems: "stretch",
  },
  priceText: {
    fontSize: 13.5,
    color: colors.textMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  freshnessText: {
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: "right",
  },
  // UI32 (ADR 0065 §Decision 3): subtle warning tint for stale snapshots —
  // same size/alignment as freshnessText, only the color differs (reuses the
  // row's existing amber warning token from the hit badge/top-pick badge).
  freshnessTextStale: {
    fontSize: 11,
    color: colors.amberTagText,
    textAlign: "right",
  },
  mutedCTA: {
    opacity: 0.5,
  },
  errorCallout: {
    backgroundColor: colors.noValidBg,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  errorText: {
    fontSize: 13,
    color: colors.noValidText,
  },
  errorActions: {
    flexDirection: "row",
    gap: 8,
  },
  handoffErrorText: {
    fontSize: 12,
    color: colors.noValidText,
  },
});
