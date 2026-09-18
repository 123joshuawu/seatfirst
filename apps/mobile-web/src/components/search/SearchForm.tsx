import {
  useSubmitSearchViewModel,
  type SubmitSearchStart,
} from "@/hooks/viewModels/useSubmitSearchViewModel";
import { useState, type ReactElement } from "react";
import { StyleSheet, Pressable, View } from "react-native";
import { colors } from "@/theme/colors";
import { AppText } from "@/components/core/AppText";
import { FadeInView } from "@/components/core/FadeInView";
import { PrimaryButton } from "@/components/core/Button";
import { ChipRow } from "./ChipRow";
import { MovieField } from "./MovieField";
import { TheaterField } from "./TheaterField";
import { WhenPresetRow } from "./WhenPresetRow";
import { WhenCustomSheet } from "./WhenCustomSheet";
import { HowItWorksSheet } from "./HowItWorksSheet";
import { useSearchProgressViewModel } from "@/hooks/viewModels/useSearchProgressViewModel";

export interface SearchFormProps {
  startSearch?: SubmitSearchStart;
}

export function SearchForm({ startSearch }: SearchFormProps = {}): ReactElement {
  const vm = useSubmitSearchViewModel(startSearch ? { startSearch } : undefined);
  const progressVm = useSearchProgressViewModel();
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const { actions } = vm;
  const isLocked = progressVm.isLocked;
  const disabled = isLocked;
  const showCancel = isLocked && progressVm.searchId !== null && progressVm.searchId !== undefined;
  // UI31 (ADR 0064): once a server search exists, the theatre checklist,
  // party-size chips, and submit CTA stay editable/clickable while locked so an
  // in-situ diff-merge update can be submitted mid-run. Before the first
  // submission (searchId === null) the original lock still applies.
  const hasServerSearch = progressVm.searchId !== null && progressVm.searchId !== undefined;
  const updateFieldLocked = hasServerSearch ? false : isLocked;

  return (
    <FadeInView
      // Card padding is 20 on both mobile and desktop (was 28 on desktop; the
      // extra 16px of vertical height pushed the CTA below 900px viewports).
      style={[styles.card, { padding: 20 }, disabled && styles.cardDisabled]}
    >
      <AppText
        family="display"
        weight="800"
        style={[styles.title, !vm.isMobile && styles.titleDesktop]}
      >
        Find your seats
      </AppText>
      <AppText weight="400" style={[styles.subtitle, !vm.isMobile && styles.subtitleDesktop]}>
        {vm.isMobile
          ? "One answer, not twelve seating charts. We scan every showtime to find the best seats together."
          : "Choose where to sit before choosing when to go."}
      </AppText>
      {vm.isMobile ? (
        <Pressable
          onPress={() => setHowItWorksOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="See how it works"
          style={styles.howItWorksTrigger}
        >
          <AppText weight="600" style={styles.howItWorksTriggerText}>
            See how it works →
          </AppText>
        </Pressable>
      ) : null}
      {vm.isMobile ? (
        <HowItWorksSheet open={howItWorksOpen} onClose={() => setHowItWorksOpen(false)} />
      ) : null}

      <TheaterField
        isLocked={updateFieldLocked}
        theatreCounts={vm.theatreCounts}
        warmZeroTheatreIds={vm.warmZeroTheatreIds}
        onWidenWindow={actions.widenWindow}
        isMobile={vm.isMobile}
      />

      <MovieField
        theaterConfirmed={vm.theaterConfirmed}
        movieValue={vm.movieValue}
        movieFocused={vm.movieFocused}
        movieSuggestionsHeader={vm.movieSuggestionsHeader}
        movieSuggestions={vm.movieSuggestions}
        movieIsSearching={vm.movieIsSearching}
        movieSearchError={vm.movieSearchError}
        movieClearedNotice={vm.movieClearedNotice}
        onGateClick={actions.onMovieGateClick}
        onChangeText={actions.onMovieChange}
        onFocus={actions.onMovieFocus}
        onBlur={actions.onMovieBlur}
        isLocked={isLocked}
        movieCounts={vm.movieCounts}
        isMobile={vm.isMobile}
        warmZeroMovieIds={vm.warmZeroMovieIds}
        onWidenWindow={actions.widenWindow}
        onSelectCustomEvent={actions.onSelectCustomEvent}
        onCheckLiveSchedule={vm.onCheckLiveSchedule}
        isCheckingLiveSchedule={vm.isCheckingLiveSchedule}
        liveScheduleError={vm.liveScheduleError}
        isWarm={vm.isWarm}
      />

      <ChipRow
        label="Format"
        chips={vm.formatOptions}
        marginBottom={vm.isMobile ? 20 : 12}
        isMobile={vm.isMobile}
        isLocked={isLocked}
        {...(vm.formatCounts ? { facetCounts: vm.formatCounts } : {})}
        {...(vm.facetTotalTheatres !== undefined
          ? { totalTheatres: vm.facetTotalTheatres }
          : vm.warmTheatreCount != null
            ? { totalTheatres: vm.warmTheatreCount }
            : {})}
      />

      <ChipRow
        label="How many seats?"
        chips={vm.partySizeChips}
        shape="square"
        marginBottom={vm.isMobile ? 20 : 12}
        isMobile={vm.isMobile}
        isLocked={updateFieldLocked}
      />
      <AppText weight="400" style={[styles.helperText, { marginBottom: vm.isMobile ? 20 : 10 }]}>
        We&apos;ll keep your group together.
      </AppText>

      <WhenPresetRow
        isLocked={isLocked}
        isMobile={vm.isMobile}
        hideResolvedReadout={!vm.isMobile}
      />

      <WhenCustomSheet />

      {vm.admissionRejected && vm.admissionRejectedLabel ? (
        <View style={styles.admissionBanner}>
          <AppText
            weight="600"
            style={styles.admissionText}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {vm.admissionRejectedLabel}
          </AppText>
        </View>
      ) : null}

      {progressVm.cancelError ? (
        <View style={styles.cancelErrorBanner}>
          <AppText weight="600" style={styles.cancelErrorText} accessibilityRole="alert">
            {progressVm.cancelError}
          </AppText>
        </View>
      ) : null}

      {showCancel ? (
        <View style={{ marginBottom: 12 }}>
          <Pressable
            onPress={
              progressVm.isCanceling ? undefined : () => void progressVm.actions.cancelSearch()
            }
            disabled={progressVm.isCanceling}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            accessibilityState={{ disabled: progressVm.isCanceling, busy: progressVm.isCanceling }}
            style={{
              backgroundColor: colors.cardBg,
              borderWidth: 1,
              borderColor: colors.borderSoft,
              borderRadius: 12,
              paddingVertical: 12,
              alignItems: "center",
            }}
          >
            <AppText weight="600" style={{ fontSize: 14, color: colors.textPrimary }}>
              Cancel search
            </AppText>
          </Pressable>
        </View>
      ) : null}

      {vm.isMobile ? (
        <View testID="mobile-sticky-cta" style={styles.stickyCtaBar}>
          {/* ADR 0044 amendment §B: subtext lives inside the sticky container, above
          the button, so it can never be pushed below the visible viewport. */}
          {vm.ctaSubtext ? (
            <AppText weight="400" style={styles.helperText}>
              {vm.ctaSubtext}
            </AppText>
          ) : null}
          {/* ADR 0044 amendment §A: static zero-match diagnosis directly above the CTA. */}
          {vm.zeroMatchDiagnosis ? (
            <AppText weight="400" style={styles.helperText}>
              {vm.zeroMatchDiagnosis}
            </AppText>
          ) : null}
          <PrimaryButton
            label={vm.submitButtonLabel}
            onPress={actions.startSearch}
            disabled={
              vm.searchDisabled || (isLocked && !hasServerSearch) || vm.capacityGateBusy === true
            }
          />
        </View>
      ) : (
        <>
          {/* ADR 0044 amendment §A: static zero-match diagnosis directly above the CTA. */}
          {vm.zeroMatchDiagnosis ? (
            <AppText weight="400" style={styles.helperText}>
              {vm.zeroMatchDiagnosis}
            </AppText>
          ) : null}
          <PrimaryButton
            label={vm.submitButtonLabel}
            onPress={actions.startSearch}
            disabled={
              vm.searchDisabled || (isLocked && !hasServerSearch) || vm.capacityGateBusy === true
            }
          />
        </>
      )}

      {/* ADR 0044 Change 06 — states the cost/gate under the button. Desktop only:
      mobile renders ctaSubtext inside the sticky container per amendment §B.
      Amendment 2026-09-05: once a match count is known the left confirmation
      card already states the match, so the redundant final state is dropped. */}
      {!vm.isMobile && vm.ctaSubtext && vm.matchingShowtimeCount === null ? (
        <AppText weight="400" style={styles.helperText}>
          {vm.ctaSubtext}
        </AppText>
      ) : null}
      {/* UI16 — submit-time capacity gate verdict. The exceeds-ceiling message alone
       * carries a number (the exact server-returned count); the unavailable message never
       * states or implies one. */}
      {vm.capacityBlockLabel !== null ? (
        <AppText weight="400" style={styles.blockText}>
          {vm.capacityBlockLabel}
        </AppText>
      ) : null}
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    shadowColor: colors.border,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  title: {
    fontSize: 22,
    color: colors.textPrimary,
    marginBottom: 6,
  },
  // Desktop (≥680px): vertically tighter so the CTA clears ~900px viewports.
  titleDesktop: {
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textTertiary,
    marginBottom: 18,
  },
  subtitleDesktop: {
    marginBottom: 10,
  },
  howItWorksTrigger: {
    alignSelf: "flex-start",
    paddingVertical: 4,
    marginBottom: 14,
  },
  howItWorksTriggerText: {
    fontSize: 13,
    color: colors.brandDark,
  },
  admissionBanner: {
    backgroundColor: colors.cardMutedBg,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  admissionText: {
    fontSize: 13,
    color: "#b91c1c",
  },
  cancelErrorBanner: {
    backgroundColor: colors.cardMutedBg,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  cancelErrorText: {
    fontSize: 13,
    color: "#b91c1c",
  },
  helperText: {
    fontSize: 12,
    color: colors.textTertiary,
    marginBottom: 14,
  },
  // UX audit P0: on mobile the form is taller than the viewport, so the submit
  // button sits below the fold. A sticky bottom bar keeps the one existing
  // submit button visible without scrolling. Desktop renders the plain button.
  stickyCtaBar: {
    position: "sticky" as const,
    bottom: 0,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: 12,
    zIndex: 10,
  },
  blockText: {
    color: "#b91c1c",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
  windowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.cardMutedBg,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  windowLabel: {
    fontSize: 14,
    color: colors.textPrimary,
  },
});
