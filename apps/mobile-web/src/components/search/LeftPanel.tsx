import { useSubmitSearchViewModel } from "@/hooks/viewModels/useSubmitSearchViewModel";
import { useSearchProgressViewModel } from "@/hooks/viewModels/useSearchProgressViewModel";
import { useHandoffViewModel } from "@/hooks/viewModels/useHandoffViewModel";
import type { ReactElement } from "react";
import { StyleSheet, Image, Platform, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { Badge } from "@/components/core/Badge";
import { EmptyState } from "@/components/core/EmptyState";
import { SeatGrid } from "@/components/map/SeatGrid";
import { SeatLegend } from "@/components/core/SeatLegend";
import type { RecoveryOption } from "@seatfirst/core";
import type { SeatDotData, SeatGridRow } from "@/types/placement";
import { GhostResultCard } from "./GhostResultCard";

const posterStripe = StyleSheet.create({
  stripe: {
    backgroundColor: colors.mapEmptyStart,
    ...(Platform.OS === "web"
      ? {
          backgroundImage: `repeating-linear-gradient(135deg, ${colors.mapEmptyStart}, ${colors.mapEmptyStart} 6px, ${colors.posterStripe} 6px, ${colors.posterStripe} 12px)`,
        }
      : {}),
  },
});

/**
 * Live illustrative mini map for the State-2 confirmation card: 3 rows of 11 dots
 * with a centered run of `partySize` active indigo dots on the middle row,
 * mirroring the "centered, middle-third" sweet-spot copy below it. Rebuilt on every
 * render from the live `partySize` store value so it tracks the right-hand form.
 * Dot sizes match the ghost grid's sizing convention (5 idle / 7 active).
 */
const TARGET_MINI_ROWS = 3;
const TARGET_MINI_COLS = 11;
const TARGET_MINI_ACTIVE_ROW = 1;

function buildTargetMiniRows(partySize: number): SeatGridRow[] {
  const count = partySize;
  const startCol = Math.floor((TARGET_MINI_COLS - count) / 2);
  const rows: SeatGridRow[] = [];
  for (let r = 0; r < TARGET_MINI_ROWS; r += 1) {
    const dots: SeatDotData[] = [];
    for (let c = 0; c < TARGET_MINI_COLS; c += 1) {
      const active = r === TARGET_MINI_ACTIVE_ROW && c >= startCol && c < startCol + count;
      dots.push({ active, hue: "indigo", size: active ? 7 : 5 });
    }
    rows.push({ dots });
  }
  return rows;
}

/**
 * S62 (ADR 0067): venue amenity codes that are ticketing policies, not physical
 * facilities — never badged on the confirmation card. The genuinely obvious
 * pricing/membership codes from AMC's real venue vocabulary (observed in the
 * captured `theatres-market-*` filter dropdown: `discountmatinees`,
 * `militarypricingafter4pm`, `amcclubrockers` alongside facility codes like
 * `macguffins`, `wheelchairaccess`, `plushrecliners`). Compared case-insensitively;
 * everything else renders — never over-filter a real facility.
 */
const NON_FACILITY_AMENITY_CODES: ReadonlySet<string> = new Set([
  "discountmatinees",
  "militarypricingafter4pm",
  "amcclubrockers",
]);

/** Maximum venue amenity badges before the `+N more` suffix. */
const MAX_VENUE_AMENITY_BADGES = 3;

/**
 * The persistent left column across the non-result screens: an unfocused "example result"
 * before the user has picked anything, a movie/theater confirmation card while
 * searching/checking, or the auditorium seat map while rechecking/replacing/confirming.
 */
export interface LeftPanelProps {
  focusedRecoveryOption?: RecoveryOption | null;
  isReplacement?: boolean;
  hidePreviewCard?: boolean;
}

export function LeftPanel({
  focusedRecoveryOption = null,
  isReplacement = false,
  hidePreviewCard = false,
}: LeftPanelProps = {}): ReactElement | null {
  const formVm = useSubmitSearchViewModel();
  const handoffVm = useHandoffViewModel(focusedRecoveryOption);
  const progressVm = useSearchProgressViewModel();
  const vm = { ...formVm, ...handoffVm, ...progressVm };
  // S62 (ADR 0067): facility amenities for the State-2 confirmation card —
  // ticketing-policy codes filtered out, empty/filtered-to-empty renders no row.
  const venueAmenities = (vm.theatreAmenities ?? []).filter(
    (amenity) => !NON_FACILITY_AMENITY_CODES.has(amenity.code.toLowerCase()),
  );
  if (!vm.showLeftCol) return null;
  return (
    <View style={vm.isMobile ? styles.rootMobile : styles.rootDesktop}>
      <View style={styles.wordmarkRow}>
        <View style={styles.wordmarkDot} />
        <AppText weight="700" style={styles.wordmark}>
          Seatfirst
        </AppText>
      </View>

      {vm.leftIsGhost ? <GhostResultCard /> : null}

      {vm.leftIsConfirmation && !hidePreviewCard ? (
        <View style={styles.confirmationCard}>
          <View style={styles.confirmationTopRow}>
            {vm.posterUrl !== null ? (
              <Image source={{ uri: vm.posterUrl }} style={styles.poster} resizeMode="cover" />
            ) : (
              // Poster not resolved yet: same intentional-placeholder treatment as
              // MovieField — existing diagonal stripe untouched, title initial
              // centered on top in the stripe's muted palette. Hidden from
              // assistive tech; the adjacent confirmation title announces it.
              <View
                style={[styles.poster, posterStripe.stripe, styles.posterFallbackCenter]}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
              >
                <AppText weight="700" style={styles.posterMonogram}>
                  {vm.movieTitleDisplay.trim().charAt(0).toUpperCase() || "•"}
                </AppText>
              </View>
            )}
            <View style={styles.confirmationText}>
              <AppText family="display" weight="700" style={styles.confirmationTitle}>
                {vm.movieTitleDisplay}
              </AppText>
              <AppText weight="400" style={styles.confirmationSubtitle}>
                {vm.theaterDisplay}
              </AppText>
              {vm.theaterDistanceLabel !== null ? (
                <AppText weight="400" style={styles.confirmationDistance}>
                  {`${vm.theaterDistanceLabel} away`}
                </AppText>
              ) : null}
              {venueAmenities.length > 0 ? (
                <View style={styles.amenityRow}>
                  {venueAmenities.slice(0, MAX_VENUE_AMENITY_BADGES).map((amenity) => (
                    <Badge
                      key={amenity.code}
                      label={amenity.name}
                      background={colors.amberTagBg}
                      color={colors.amberTagText}
                    />
                  ))}
                  {venueAmenities.length > MAX_VENUE_AMENITY_BADGES ? (
                    <AppText weight="600" style={styles.amenityMore}>
                      {`+${venueAmenities.length - MAX_VENUE_AMENITY_BADGES} more`}
                    </AppText>
                  ) : null}
                </View>
              ) : null}
              {vm.movieRuntimeGenreLabel !== null ? (
                <AppText weight="400" style={styles.confirmationDistance}>
                  {vm.movieRuntimeGenreLabel}
                </AppText>
              ) : null}
            </View>
          </View>
          <View style={styles.targetSummary}>
            <AppText weight="600" style={styles.targetSummaryEyebrow}>
              SEARCH TARGET
            </AppText>
            <View style={styles.targetMiniMap}>
              <SeatGrid gridRows={buildTargetMiniRows(vm.partySize)} variant="full" />
            </View>
            <View style={styles.targetSummaryRow}>
              <AppText weight="400" style={styles.targetSummaryLabel}>
                Party
              </AppText>
              <AppText weight="600" style={styles.targetSummaryValue}>
                {vm.quickPartyLabel}
              </AppText>
            </View>
            <View style={styles.targetSummaryRow}>
              <AppText weight="400" style={styles.targetSummaryLabel}>
                Window
              </AppText>
              <AppText weight="600" style={styles.targetSummaryValue}>
                {vm.quickWindowLabel}
              </AppText>
            </View>
            <View style={styles.targetSummaryRow}>
              <AppText weight="400" style={styles.targetSummaryLabel}>
                Format
              </AppText>
              <AppText weight="600" style={styles.targetSummaryValue}>
                {vm.quickFormatLabel}
              </AppText>
            </View>
            <View style={styles.targetSummaryRow}>
              <AppText weight="400" style={styles.targetSummaryLabel}>
                Placement
              </AppText>
              <AppText weight="600" style={styles.targetSummaryValue}>
                {vm.seatPrefsSummaryLabel}
              </AppText>
            </View>
            <AppText weight="400" style={styles.targetStatus}>
              {vm.targetStatusLabel}
            </AppText>
          </View>
        </View>
      ) : null}
      {vm.leftIsAuditorium && vm.activePlacement ? (
        vm.isMobile && isReplacement ? (
          vm.originalPlacementLabel ? (
            <View style={styles.compactReplacementBanner}>
              <AppText weight="600" numberOfLines={1} style={styles.compactReplacementText}>
                {`Original pick: ${vm.originalPlacementLabel} (taken)`}
              </AppText>
            </View>
          ) : null
        ) : (
          <View style={styles.auditoriumCard}>
            <View style={{ width: "100%" }}>
              <AppText family="display" weight="700" style={styles.auditoriumTitle}>
                {vm.movieTitleDisplay}
              </AppText>
              <AppText weight="400" style={styles.auditoriumSubtitle}>
                {vm.theaterName} · {vm.activePlacement.format}
              </AppText>
            </View>
            <SeatGrid gridRows={vm.gridRows} variant="full" />
            {/* UI39 (ADR 0069): shape-vocabulary key directly under the seat map. Compact
                so the seats summary below never gets pushed off-screen on short viewports.
                Spacing comes from auditoriumCard's own gap — no extra wrapper needed. */}
            <SeatLegend compact />
            <AppText weight="600" style={styles.auditoriumSeats}>
              {vm.activePlacement.seats}
            </AppText>
          </View>
        )
      ) : null}
      {/* UI38: companion HUD with zero matching showtimes — none of the
        ghost/confirmation/auditorium branches match, so the panel falls
        through to a bare wordmark row. totalShowtimes/isChecking ride the
        existing progress view-model; no new view-model state. */}
      {!vm.leftIsGhost &&
      !vm.leftIsConfirmation &&
      !(vm.leftIsAuditorium && vm.activePlacement) &&
      !vm.isChecking &&
      vm.totalShowtimes === 0 ? (
        <EmptyState
          title="No seats to preview"
          description="Adjust your filters or search criteria to inspect seat availability."
          testID="empty-state-companion"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rootMobile: {
    width: "100%",
    gap: 16,
  },
  rootDesktop: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 320,
    maxWidth: 420,
    minWidth: 280,
    gap: 16,
    position: "sticky",
    top: 48,
  },
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  wordmarkDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.brand,
  },
  wordmark: {
    fontSize: 12,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  confirmationCard: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 14,
  },
  confirmationTopRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
  poster: {
    width: 80,
    aspectRatio: 2 / 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Poster-fallback overlay: centers the title-initial monogram over the
  // untouched diagonal-stripe treatment (posterStripe.stripe is never restyled).
  posterFallbackCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  // Muted monogram glyph — matches the stripe's neutral palette
  // (textTertiary #766f64 on mapEmptyStart #e9e5dd): subtle, not loud.
  // Larger than MovieField's (80px-wide poster vs 34px).
  posterMonogram: {
    fontSize: 28,
    color: colors.textTertiary,
  },
  confirmationText: {
    flex: 1,
    minWidth: 0,
  },
  confirmationTitle: {
    fontSize: 15,
    color: colors.textPrimary,
  },
  confirmationSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  confirmationDistance: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  amenityRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  amenityMore: {
    fontSize: 12,
    color: colors.textMuted,
  },
  targetSummary: {
    borderTopWidth: 1,
    borderTopColor: colors.borderHairline,
    paddingTop: 14,
    gap: 4,
  },
  targetMiniMap: {
    alignItems: "center",
    marginVertical: 8,
  },
  targetSummaryEyebrow: {
    fontSize: 11,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  targetSummaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  targetSummaryLabel: {
    fontSize: 13,
    color: colors.textMuted,
    width: 76,
    flexShrink: 0,
  },
  targetSummaryValue: {
    fontSize: 13,
    color: colors.textPrimary,
    flex: 1,
    textAlign: "right",
  },
  targetStatus: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 8,
  },
  checkingLine: {
    textAlign: "center",
    fontSize: 13,
    color: colors.textMuted,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  phaseDetail: {
    textAlign: "center",
    fontSize: 12,
    color: colors.textTertiary,
    fontStyle: "italic",
  },
  auditoriumCard: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 22,
    alignItems: "center",
    gap: 14,
  },
  auditoriumTitle: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  auditoriumSubtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  auditoriumSeats: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  compactReplacementBanner: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  compactReplacementText: {
    fontSize: 13,
    color: colors.textPrimary,
  },
});
