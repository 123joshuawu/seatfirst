import { useSearchResultsViewModel } from "@/hooks/viewModels/useSearchResultsViewModel";
import { useSearchProgressViewModel } from "@/hooks/viewModels/useSearchProgressViewModel";
import {
  useSubmitSearchViewModel,
  type SubmitSearchStart,
} from "@/hooks/viewModels/useSubmitSearchViewModel";
import { useEffect, useState, type ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { Badge } from "@/components/core/Badge";
import { FadeInView } from "@/components/core/FadeInView";
import { ProgressBar } from "@/components/core/ProgressBar";
import { SecondaryButton } from "@/components/core/Button";
import { ShowtimeList, isHit } from "@/components/search/ShowtimeList";
import { QuickEditBar } from "./QuickEditBar";
import { PreferBar } from "./PreferBar";
import { NO_PREFERENCE, type PreferToggles } from "@/lib/preferSort";
import { formatCodeToPref } from "@/lib/buildSearchSpec";
import { searchErrorDetailLabel } from "@/lib/presentation";

export interface ResultScreenProps {
  startSearch?: SubmitSearchStart;
  showEditAction?: boolean;
}

export function ResultScreen({
  startSearch,
  showEditAction = true,
}: ResultScreenProps): ReactElement {
  const searchVm = useSearchResultsViewModel();
  const progressVm = useSearchProgressViewModel();
  const formVm = useSubmitSearchViewModel(startSearch ? { startSearch } : undefined);
  const vm = {
    ...searchVm,
    ...progressVm,
    ...formVm,
    actions: { ...searchVm.actions, ...progressVm.actions, ...formVm.actions },
  };
  const banner = vm.terminalBannerLabel;
  const otherFormats = vm.otherFormatsLabel;

  const [toggles, setToggles] = useState<PreferToggles>(NO_PREFERENCE);

  useEffect(() => {
    setToggles(NO_PREFERENCE);
  }, [vm.searchId]);

  // Terminal poll/subscription failure (e.g. persistent `searches.get` 500 after
  // polling exhausted its retry budget) — halt the skeleton/progress entirely
  // and surface a retry card instead of spinning forever.
  if (progressVm.error !== null) {
    const searchError = progressVm.error;
    // UI31 fix: never render the raw CONTINUATION_NOT_DEFERRED backend code
    // verbatim — searchErrorDetailLabel maps that single race code to friendly
    // copy and preserves the `message (code)` debug format for all others.
    const detail = searchErrorDetailLabel(searchError.message, searchError.code);
    const handleRetry = (): void => {
      vm.actions.clearSearchError();
      vm.actions.startSearch();
    };
    return (
      <FadeInView style={{ width: "100%", maxWidth: 920, gap: 16 }}>
        <QuickEditBar
          movieTitle={vm.movieTitleDisplay}
          theaterName={vm.theaterName}
          quickFormatLabel={vm.quickFormatLabel}
          quickPartyLabel={vm.quickPartyLabel}
          quickWindowLabel={vm.quickWindowLabel}
          showEditAction={showEditAction}
          actions={vm.actions}
        />
        <View style={styles.errorCard} accessibilityRole="alert">
          <AppText weight="600" style={styles.errorText}>
            Couldn&apos;t check seats
          </AppText>
          <AppText weight="400" style={styles.errorSubText}>
            {detail}
          </AppText>
          <View style={styles.errorActions}>
            <SecondaryButton
              label="Try again"
              onPress={handleRetry}
              accessibilityHint="Retries the seat search"
            />
          </View>
        </View>
      </FadeInView>
    );
  }
  const formats = (() => {
    const seen = new Set<string>();
    for (const e of vm.scheduleSkeleton) {
      const pref = formatCodeToPref(e.formatCode ?? null);
      seen.add(pref);
    }
    return Array.from(seen);
  })();

  const stageCopy = (() => {
    if (vm.searchStatus === "PENDING_SCHEDULE") return `Finding showtimes for ${vm.theaterName}…`;
    if (vm.searchStatus === "RUNNING") {
      if (vm.checkedCount < vm.totalShowtimes) {
        return `Scanning seating charts across ${vm.totalShowtimes} showtimes…`;
      }
      return `Evaluating adjacent seats for party of ${vm.partySize}…`;
    }
    return vm.totalShowtimes > 0
      ? `Checking ${vm.checkedCount} of ${vm.totalShowtimes} showtimes`
      : "Checking showtimes…";
  })();

  const matchCount = vm.scheduleSkeleton.filter((e) => isHit(e, vm.groups)).length;
  const discoveryMilestone =
    vm.searchStatus === "RUNNING" && vm.checkedCount < vm.totalShowtimes && matchCount > 0
      ? `Checking ${vm.checkedCount} of ${vm.totalShowtimes} showtimes · Found ${matchCount} so far.`
      : null;

  const theatreChips = (() => {
    const byTheatre = new Map<string, { resolved: number; total: number }>();
    for (const e of vm.scheduleSkeleton) {
      const bucket = byTheatre.get(e.theatreId) ?? { resolved: 0, total: 0 };
      bucket.total += 1;
      if (e.resolved) bucket.resolved += 1;
      byTheatre.set(e.theatreId, bucket);
    }
    if (byTheatre.size <= 1) return null;
    return Array.from(byTheatre.entries()).map(([theatreId, counts]) => ({
      theatreId,
      name: vm.theatreNameById?.get(theatreId) ?? "Theatre",
      resolved: counts.resolved,
      total: counts.total,
      complete: counts.total > 0 && counts.resolved === counts.total,
    }));
  })();

  return (
    <FadeInView style={{ width: "100%", maxWidth: 920, gap: 16 }}>
      <QuickEditBar
        movieTitle={vm.movieTitleDisplay}
        theaterName={vm.theaterName}
        quickFormatLabel={vm.quickFormatLabel}
        quickPartyLabel={vm.quickPartyLabel}
        quickWindowLabel={vm.quickWindowLabel}
        showEditAction={showEditAction}
        actions={vm.actions}
      />

      {banner ? (
        <View style={styles.banner}>
          <AppText weight="600" style={styles.bannerText}>
            {banner}
          </AppText>
        </View>
      ) : null}

      {/* UI15.3 — loading lives on the results surface for the whole scan; terminal empty-skeleton still communicates via progress without inventing rows */}
      {vm.scheduleSkeleton.length > 0 || vm.isChecking || vm.isTerminal ? (
        <View style={styles.progressBlock} accessibilityRole="progressbar">
          <AppText weight="400" style={styles.checkingLine}>
            {(() => {
              const allResolved = vm.totalShowtimes > 0 && vm.checkedCount >= vm.totalShowtimes;
              const useChecked = vm.isTerminal || allResolved;
              if (useChecked) {
                return vm.totalShowtimes > 0
                  ? `Checked ${vm.checkedCount} of ${vm.totalShowtimes} showtimes`
                  : "Checked showtimes";
              }
              return stageCopy;
            })()}
          </AppText>
          {theatreChips ? (
            <View style={styles.chipRow}>
              {theatreChips.map((chip) => (
                <AppText
                  key={chip.theatreId}
                  weight="400"
                  style={chip.complete ? styles.chipTextComplete : styles.chipText}
                >
                  {chip.complete
                    ? `✓ ${chip.name}: ${chip.resolved}/${chip.total}`
                    : `${chip.name}: ${chip.resolved}/${chip.total}`}
                </AppText>
              ))}
            </View>
          ) : null}
          {discoveryMilestone ? (
            <AppText weight="400" style={styles.milestoneLine}>
              {discoveryMilestone}
            </AppText>
          ) : null}
          {vm.etaLabel ? (
            <AppText weight="400" style={styles.etaLine}>
              {vm.etaLabel}
            </AppText>
          ) : null}
          <ProgressBar
            resolved={vm.checkedCount}
            total={vm.totalShowtimes}
            isTerminal={vm.isTerminal}
          />
          {vm.phaseDetail ? (
            <AppText weight="400" style={styles.phaseDetail}>
              {vm.phaseDetail}
            </AppText>
          ) : null}
        </View>
      ) : null}

      {vm.scheduleSkeleton.length > 0 ? (
        <PreferBar value={toggles} onChange={setToggles} formats={formats} />
      ) : null}

      {/* UI15.1/UI15.2 — one flat ranked list; no placement hero, no grouping.
          Same component and order source across checking and terminal states. */}
      <ShowtimeList
        skeleton={vm.scheduleSkeleton}
        groups={vm.groups}
        partySize={vm.partySize}
        resolved={vm.checkedCount}
        total={vm.totalShowtimes}
        terminalCause={vm.terminalCause}
        searchStatus={vm.searchStatus}
        isTerminal={vm.isTerminal}
        onCheckMore={vm.canCheckMore ? vm.actions.checkMore : undefined}
        onEditSearch={vm.actions.backToSearch}
        onHandoff={vm.actions.startHandoff}
        handoffEligible={vm.handoffEligibleShowtimeIds}
        answerPlacements={vm.answerPlacementByShowtimeId}
        provenanceByShowtimeId={vm.provenanceByShowtimeId}
        recheckingShowtimeId={vm.recheckingShowtimeId}
        recheckSelectedShowtimeId={vm.recheckTargetShowtimeId}
        recheckResult={vm.recheckResult}
        recheckError={vm.recheckInlineError}
        onClearRecheck={vm.actions.clearRecheck}
        takenShowtimeIds={vm.takenShowtimeIds}
        toggles={toggles}
        placeholderCount={vm.previewPlaceholderCount ?? null}
        theaterName={vm.theaterName}
        theatreNameById={vm.theatreNameById}
        compact={vm.isMobile}
      />
      {/* UI15.6 — HEDGED keeps its mode communication as a note, not a card hierarchy */}
      {vm.answerMode === "HEDGED" ? (
        <View style={styles.modeNote}>
          <Badge
            label="No exact match"
            background={colors.noExactBg}
            color={colors.noExactText}
            variant="eyebrow"
          />
          <SecondaryButton
            label="Change format"
            onPress={vm.actions.changeFormat}
            accessibilityHint="Opens format picker"
          />
        </View>
      ) : null}

      {/* UI15.6 — EMPTY keeps its cause heading and suggestion actions */}
      {vm.answerMode === "EMPTY" ? (
        <View style={styles.modeNote}>
          {otherFormats ? (
            <AppText weight="400" style={styles.otherFormatsLabel}>
              {otherFormats}
            </AppText>
          ) : null}
          <AppText family="display" weight="700" style={styles.emptyHeading}>
            {vm.emptyCauseLabel ?? "No valid placement found for this window."}
          </AppText>
          {vm.noValidActions.map((action) => (
            <View key={action.label} style={styles.suggestionRow}>
              <SecondaryButton
                label={action.label}
                onPress={action.onPress}
                accessibilityHint="Applies this suggestion"
              />
            </View>
          ))}
        </View>
      ) : null}

      {otherFormats && vm.answerMode !== "EMPTY" ? (
        <AppText weight="400" style={styles.otherFormatsLabel}>
          {otherFormats}
        </AppText>
      ) : null}
    </FadeInView>
  );
}
const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.cardMutedBg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bannerText: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  progressBlock: {
    gap: 8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
  },
  errorCard: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 26,
    gap: 12,
    alignItems: "center",
  },
  errorText: {
    fontSize: 14,
    color: colors.textPrimary,
    textAlign: "center",
  },
  errorSubText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  chipText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  chipTextComplete: {
    fontSize: 11,
    color: colors.textPrimary,
  },
  milestoneLine: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  etaLine: {
    fontSize: 12,
    color: colors.textMuted,
  },
  checkingLine: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  phaseDetail: {
    fontSize: 12,
    color: colors.textMuted,
  },
  modeNote: {
    gap: 10,
    alignItems: "flex-start",
  },
  emptyHeading: {
    fontSize: 16,
    lineHeight: 22.4,
    color: colors.textPrimary,
  },
  suggestionRow: {
    width: "100%",
    gap: 8,
  },
  otherFormatsLabel: {
    fontSize: 12,
    color: colors.textTertiary,
  },
});
