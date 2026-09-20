import { useState, type ReactElement } from "react";
import { Image, StyleSheet, Platform, Pressable, TextInput, View } from "react-native";
import { colors } from "@/theme/colors";
import { fontFamily } from "@/theme/typography";
import type { MovieSuggestion } from "@/hooks/viewModels/useSubmitSearchViewModel";
import { AppText } from "@/components/core/AppText";
import { AutocompleteFieldShell, AutocompletePopover } from "@/components/core/Autocomplete";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { getFacetDisplay, shouldDimFacet } from "@/lib/facetCounts";

function MoviePoster({
  posterUrl,
  title,
}: {
  posterUrl: string | null | undefined;
  title: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  if (posterUrl == null || posterUrl === "" || failed) {
    // Poster not resolved yet: keep the neutral diagonal-stripe treatment as the
    // base, with the title's first initial centered on top so the placeholder
    // reads as intentional rather than a rendering glitch. The stripe styles
    // themselves are untouched; centering comes from posterFallbackCenter.
    // Hidden from assistive tech (mirroring the poster Image) — the adjacent
    // suggestion label already announces the title.
    const initial = title.trim().charAt(0).toUpperCase() || "•";
    return (
      <View
        style={[styles.poster, styles.posterFallback, styles.posterFallbackCenter]}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
      >
        <AppText weight="700" style={styles.posterMonogram}>
          {initial}
        </AppText>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: posterUrl }}
      style={styles.poster}
      resizeMode="cover"
      onError={() => setFailed(true)}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
    />
  );
}
export interface MovieFieldProps {
  theaterConfirmed: boolean;
  movieValue: string;
  movieFocused: boolean;
  movieSuggestionsHeader: string;
  movieSuggestions: MovieSuggestion[];
  movieIsSearching: boolean;
  movieSearchError: string | null;
  movieClearedNotice: string | null;
  onGateClick: () => void;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  isLocked?: boolean;
  /** UI18.6 — tri-state counts per movie. Map keyed by label (movie title). */
  movieCounts?:
    | Map<string, { count: number; coldTheatreCount: number }>
    | Record<string, { count: number; coldTheatreCount: number }>
    | undefined;
  warmZeroMovieIds?: Set<string> | undefined;
  onWidenWindow?: (() => void) | undefined;
  /** Total theatres for n+ vs not-checked-yet (selectedTheatres.length). */
  totalTheatres?: number;
  /**
   * Mobile override — forwards to the suggestion popovers so the list renders
   * as a bottom sheet. Defaults to the shared viewport check (width < 680,
   * same as `vm.isMobile`).
   */
  isMobile?: boolean;
  /**
   * UI42.5 — custom event fallback. When provided and `movieValue` is
   * non-blank, a `🔍 Search for event: "[typed text]"` row renders at the
   * bottom of the suggestion list; pressing it calls this with the trimmed
   * typed text.
   */
  onSelectCustomEvent?: ((query: string) => void) | undefined;
  /**
   * UI42.6 — dropdown footer CTA. When provided, the suggestion popover
   * renders a "Check today's live schedule" footer action below the list.
   */
  onCheckLiveSchedule?: (() => void) | undefined;
  /** UI42.6 — loading/disabled state for the footer CTA while refresh is in flight. */
  isCheckingLiveSchedule?: boolean;
  /** UI42 Cold vs Hot mode flag for mode-specific footer prominence. */
  isWarm?: boolean;
  /**
   * UI42.6 — generic failure state when `refreshSchedule` resolves FAILED or
   * rejects (owned + set by the viewmodel). When non-null, renders an error
   * line below the live-schedule footer in the open suggestion popover.
   */
  liveScheduleError?: string | null;
}

/**
 * UI42.4 — `MovieSuggestion` (from `useSubmitSearchViewModel`) carries these
 * badge/year fields natively; read them directly.
 */

/**
 * UI42.3/42.4 — display title with release year (e.g. `Nosferatu (2024)`).
 * Task A may already bake the year into `label` itself; when `label` already
 * contains `(year)`, render it verbatim instead of doubling the suffix.
 */
function getSuggestionTitle(item: MovieSuggestion): string {
  const { releaseYear } = item;
  if (releaseYear == null) return item.label;
  if (item.label.includes(`(${releaseYear})`)) return item.label;
  return `${item.label} (${releaseYear})`;
}

function getSuggestionBadge(item: MovieSuggestion): string | null {
  return item.badge ?? null;
}

function SuggestionBadge({ text }: { text: string }): ReactElement {
  const isAmcEvent = text === "AMC Event";
  return (
    <View
      style={[styles.badge, isAmcEvent ? styles.badgeAmc : styles.badgeUnverified]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
    >
      <AppText
        weight="600"
        style={[styles.badgeText, isAmcEvent ? styles.badgeTextAmc : styles.badgeTextUnverified]}
      >
        {text}
      </AppText>
    </View>
  );
}

export function MovieField({
  theaterConfirmed,
  movieValue,
  movieFocused,
  movieSuggestionsHeader,
  movieSuggestions,
  movieIsSearching,
  movieSearchError,
  movieClearedNotice,
  onGateClick,
  onChangeText,
  onFocus,
  onBlur,
  isLocked = false,
  movieCounts,
  warmZeroMovieIds,
  onWidenWindow,
  totalTheatres,
  isMobile,
  onSelectCustomEvent,
  onCheckLiveSchedule,
  isCheckingLiveSchedule = false,
  isWarm,
  liveScheduleError,
}: MovieFieldProps): ReactElement {
  void onGateClick;
  const effectiveTotal =
    totalTheatres ??
    (movieCounts
      ? movieCounts instanceof Map
        ? movieCounts.size
        : Object.keys(movieCounts).length
      : 1);
  // UI42.5 — custom event fallback row, shown at the bottom of the suggestion
  // list whenever the user has typed non-blank text.
  const trimmedEventQuery = movieValue.trim();
  const showCustomEventRow = trimmedEventQuery.length > 0 && onSelectCustomEvent != null;
  // UI42.6 — dropdown footer CTA. Rendered below the suggestion list whenever
  // the caller wires the live-schedule check; `isWarm === false` (Cold Mode)
  // gets a more prominent tinted treatment, Hot Mode a neutral one.
  const showLiveScheduleFooter = onCheckLiveSchedule != null;
  const customEventRow = showCustomEventRow ? (
    <Pressable
      onPress={() => onSelectCustomEvent?.(trimmedEventQuery)}
      accessibilityRole="menuitem"
      accessibilityLabel={`🔍 Search for event: "${trimmedEventQuery}"`}
      accessibilityHint="Searches for this custom event title"
      focusable={!isLocked}
      {...(Platform.OS === "web" ? ({ role: "option" } as unknown as Record<string, unknown>) : {})}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.item,
        (pressed || hovered) && !isLocked && styles.itemPressed,
        Platform.OS === "web"
          ? ({ cursor: isLocked ? "default" : "pointer" } as unknown as Record<string, unknown>)
          : null,
      ]}
    >
      <AppText
        style={[styles.itemLabel, { flex: 1 }]}
      >{`🔍 Search for event: "${trimmedEventQuery}"`}</AppText>
    </Pressable>
  ) : null;
  const liveScheduleFooter = showLiveScheduleFooter ? (
    <View style={[styles.footer, isWarm === false && styles.footerCold]}>
      <AppText style={styles.footerText}>Looking for a special event or Fathom screening? </AppText>
      <Pressable
        onPress={isCheckingLiveSchedule ? undefined : onCheckLiveSchedule}
        disabled={!!isCheckingLiveSchedule}
        accessibilityRole="button"
        accessibilityLabel={
          isCheckingLiveSchedule ? "Checking today's live schedule" : "Check today's live schedule"
        }
        accessibilityState={{ disabled: !!isCheckingLiveSchedule, busy: !!isCheckingLiveSchedule }}
        accessibilityHint="Checks today's live schedule"
        focusable={!isCheckingLiveSchedule}
      >
        <AppText weight="600" style={styles.footerLink}>
          {isCheckingLiveSchedule ? "Checking…" : "Check today's live schedule"}
        </AppText>
      </Pressable>
    </View>
  ) : null;
  // UI42.6 — failure line for the on-demand refresh; rendered directly above
  // the footer CTA (adjacent to the trigger button) so a FAILED resolve or
  // rejected mutation is visible without scrolling when tapped. Below the
  // footer it sat at the bottom of the 326px-capped scroll region — scrolled
  // out of view with zero visible feedback. Independent of the footer-flag
  // gate so the message survives even if the CTA handler is momentarily unwired.
  const liveScheduleErrorRow =
    liveScheduleError != null && liveScheduleError !== "" ? (
      <View style={styles.footerErrorWrap}>
        <AppText
          style={styles.footerError}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {liveScheduleError}
        </AppText>
      </View>
    ) : null;
  // Desktop (isMobile === false) renders the same field with tighter vertical
  // rhythm so the form CTA clears ~900px viewports. `undefined` (no override
  // passed) keeps the long-standing mobile values.
  const desktop = isMobile === false;
  return (
    // A positioned popover's own zIndex only wins within its parent's stacking context, not
    // against the ChipRow siblings further down this card — this wrapper needs its own zIndex
    // to paint the whole field (dropdown included) above the form content below it.
    <View style={{ marginBottom: desktop ? 12 : 20, zIndex: 2 }}>
      <EyebrowLabel marginBottom={desktop ? 6 : 8}>Movie</EyebrowLabel>
      <View>
        <AutocompleteFieldShell focused={movieFocused && !isLocked} disabled={isLocked}>
          <View style={styles.inputRow}>
            <TextInput
              value={movieValue}
              onChangeText={isLocked ? undefined : onChangeText}
              onFocus={isLocked ? undefined : onFocus}
              onBlur={onBlur}
              placeholder="Search or browse what's playing"
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.input,
                desktop && styles.inputDesktop,
                isLocked && styles.inputDisabled,
              ]}
              editable={!isLocked}
              selectTextOnFocus={!isLocked}
              accessibilityRole="combobox"
              accessibilityLabel="Movie title"
              accessibilityState={{ disabled: !!isLocked, expanded: movieFocused && !isLocked }}
              accessibilityHint="Search or browse movies"
              focusable={!isLocked}
              {...(Platform.OS === "web"
                ? ({
                    role: "combobox",
                    "aria-expanded": movieFocused && !isLocked,
                    "aria-haspopup": "listbox",
                    "aria-controls": "movie-listbox",
                    "aria-autocomplete": "list",
                    // Screen-reader/autofill hook for the HTML input; distinct
                    // from the "movie-listbox" popover id above.
                    id: "seatfirst-movie",
                    name: "movie",
                  } as unknown as Record<string, unknown>)
                : {})}
            />
            <AppText
              weight="500"
              style={styles.chevron}
              accessible={false}
              importantForAccessibility="no"
            >
              ›
            </AppText>
          </View>
        </AutocompleteFieldShell>
        {movieFocused && !isLocked ? (
          !theaterConfirmed ? (
            <AutocompletePopover
              id="movie-listbox"
              header={movieSuggestionsHeader}
              isMobile={isMobile}
              onClose={onBlur}
            >
              <View style={styles.item}>
                <AppText style={styles.itemLabelMuted}>
                  Choose where to see movie availability.
                </AppText>
              </View>
            </AutocompletePopover>
          ) : movieSearchError ? (
            <AutocompletePopover
              id="movie-listbox"
              header={movieSuggestionsHeader}
              alert
              isMobile={isMobile}
              onClose={onBlur}
            >
              <View style={styles.item}>
                <AppText style={styles.itemLabelError}>{movieSearchError}</AppText>
              </View>
            </AutocompletePopover>
          ) : movieIsSearching ? (
            <AutocompletePopover
              id="movie-listbox"
              header={movieSuggestionsHeader}
              isMobile={isMobile}
              onClose={onBlur}
            >
              <View
                style={styles.item}
                accessibilityLiveRegion="polite"
                {...(Platform.OS === "web"
                  ? ({ role: "status" } as unknown as Record<string, unknown>)
                  : {})}
              >
                <AppText style={styles.itemLabelMuted}>Loading…</AppText>
              </View>
            </AutocompletePopover>
          ) : movieSuggestions.length > 0 ? (
            movieCounts ? (
              <AutocompletePopover
                id="movie-listbox"
                header={movieSuggestionsHeader}
                scrollMaxHeight={326}
                isMobile={isMobile}
                onClose={onBlur}
              >
                <View style={styles.moviesGrid}>
                  {movieSuggestions.map((item, i) => {
                    const entry: { count: number; coldTheatreCount: number } | undefined = (() => {
                      if (!movieCounts) return undefined;
                      if (movieCounts instanceof Map)
                        return (
                          movieCounts as Map<string, { count: number; coldTheatreCount: number }>
                        ).get(item.label);
                      return (
                        movieCounts as Record<string, { count: number; coldTheatreCount: number }>
                      )[item.label];
                    })();
                    const display = entry ? getFacetDisplay(entry, effectiveTotal) : null;
                    const warmZero = (() => {
                      if (warmZeroMovieIds?.has(item.label)) return true;
                      if (!entry) return false;
                      return shouldDimFacet(entry, effectiveTotal);
                    })();
                    const countText = display ? display.text : null;
                    const isRowDisabled = !!isLocked || warmZero;
                    // UI42.4 — title with release year + expectation badge.
                    const suggestionTitle = getSuggestionTitle(item);
                    const suggestionBadge = getSuggestionBadge(item);
                    return (
                      <Pressable
                        key={i}
                        onPress={isRowDisabled ? undefined : item.onPress}
                        disabled={isRowDisabled}
                        accessibilityRole="menuitem"
                        accessibilityLabel={`${suggestionTitle}${suggestionBadge ? `, ${suggestionBadge}` : ""}${countText ? `, ${countText}` : ""}`}
                        accessibilityState={{ disabled: !!isRowDisabled }}
                        focusable={!isRowDisabled}
                        {...(Platform.OS === "web"
                          ? ({ role: "option" } as unknown as Record<string, unknown>)
                          : {})}
                        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                          styles.item,
                          styles.movieCard,
                          warmZero && { opacity: 0.5 },
                          warmZero && styles.itemDisabled,
                          (pressed || hovered) && !isRowDisabled && styles.itemPressed,
                          Platform.OS === "web"
                            ? ({
                                cursor: isRowDisabled ? "default" : "pointer",
                              } as unknown as Record<string, unknown>)
                            : null,
                        ]}
                      >
                        <MoviePoster posterUrl={item.posterUrl} title={suggestionTitle} />
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={styles.titleRow}>
                            <AppText style={[styles.itemLabel, warmZero && { opacity: 0.5 }]}>
                              {suggestionTitle}
                            </AppText>
                            {suggestionBadge ? <SuggestionBadge text={suggestionBadge} /> : null}
                          </View>
                          {countText ? (
                            <AppText weight="400" style={styles.countLabel}>
                              {countText === "not checked yet"
                                ? countText
                                : `${countText} showtime${countText === "1" ? "" : "s"}`}
                            </AppText>
                          ) : null}
                        </View>
                        {warmZero && onWidenWindow ? (
                          <Pressable
                            onPress={isLocked ? undefined : onWidenWindow}
                            disabled={isLocked}
                            accessibilityRole="button"
                            accessibilityLabel="Try tomorrow"
                            accessibilityHint="Widens window to tomorrow"
                            focusable={!isLocked}
                            style={styles.forwardAction}
                          >
                            <AppText weight="600" style={styles.forwardActionText}>
                              none · Try tomorrow →
                            </AppText>
                          </Pressable>
                        ) : null}
                      </Pressable>
                    );
                  })}
                  {customEventRow}
                </View>
                {liveScheduleErrorRow}
                {liveScheduleFooter}
              </AutocompletePopover>
            ) : (
              <AutocompletePopover
                id="movie-listbox"
                header={movieSuggestionsHeader}
                scrollMaxHeight={326}
                isMobile={isMobile}
                onClose={onBlur}
              >
                <View style={styles.moviesGrid}>
                  {movieSuggestions.map((item, i) => {
                    // UI42.4 — title with release year + expectation badge.
                    const suggestionTitle = getSuggestionTitle(item);
                    const suggestionBadge = getSuggestionBadge(item);
                    return (
                      <Pressable
                        key={i}
                        onPress={isLocked ? undefined : item.onPress}
                        disabled={!!isLocked}
                        accessibilityRole="menuitem"
                        accessibilityLabel={`${suggestionTitle}${suggestionBadge ? `, ${suggestionBadge}` : ""}`}
                        accessibilityState={{ disabled: !!isLocked }}
                        focusable={!isLocked}
                        {...(Platform.OS === "web"
                          ? ({ role: "option" } as unknown as Record<string, unknown>)
                          : {})}
                        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                          styles.item,
                          styles.movieCard,
                          (pressed || hovered) && !isLocked && styles.itemPressed,
                          Platform.OS === "web"
                            ? ({ cursor: isLocked ? "default" : "pointer" } as unknown as Record<
                                string,
                                unknown
                              >)
                            : null,
                        ]}
                      >
                        <MoviePoster posterUrl={item.posterUrl} title={suggestionTitle} />
                        <View style={{ flex: 1 }}>
                          <View style={styles.titleRow}>
                            <AppText style={styles.itemLabel}>{suggestionTitle}</AppText>
                            {suggestionBadge ? <SuggestionBadge text={suggestionBadge} /> : null}
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                  {customEventRow}
                </View>
                {liveScheduleErrorRow}
                {liveScheduleFooter}
              </AutocompletePopover>
            )
          ) : (
            <AutocompletePopover
              id="movie-listbox"
              header={movieSuggestionsHeader}
              isMobile={isMobile}
              onClose={onBlur}
            >
              <View style={styles.item}>
                <AppText style={styles.itemLabelMuted}>No movies found</AppText>
              </View>
              {showCustomEventRow ? <View style={styles.moviesGrid}>{customEventRow}</View> : null}
              {liveScheduleErrorRow}
              {liveScheduleFooter}
            </AutocompletePopover>
          )
        ) : null}
        {movieClearedNotice ? (
          <AppText
            weight="400"
            style={styles.notice}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {movieClearedNotice}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  input: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 6,
    fontSize: 15,
    fontFamily: fontFamily.bodyMedium,
    color: colors.textPrimary,
  },
  // Desktop (≥680px): 1px less text-row height; font size unchanged.
  inputDesktop: {
    paddingVertical: 4,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  chevron: {
    fontSize: 18,
    color: colors.textTertiary,
    transform: [{ rotate: "90deg" }],
    marginLeft: 8,
  },
  notice: {
    fontSize: 12,
    color: colors.brandDark,
    marginTop: 6,
  },
  moviesGrid: {
    padding: 10,
    gap: 4,
  },
  movieCard: {
    // Standard list item styling
  },
  poster: {
    width: 34,
    height: 50,
    borderRadius: 4,
    backgroundColor: colors.borderSoft,
  },
  posterFallback: {
    backgroundColor: colors.mapEmptyStart,
    ...(Platform.OS === "web"
      ? ({
          backgroundImage: `repeating-linear-gradient(135deg, ${colors.mapEmptyStart}, ${colors.mapEmptyStart} 6px, ${colors.posterStripe} 6px, ${colors.posterStripe} 12px)`,
        } as unknown as Record<string, unknown>)
      : {}),
  },
  // Poster-fallback overlay: centers the title-initial monogram over the
  // untouched diagonal-stripe treatment. Kept separate from posterFallback so
  // the stripe itself is never restyled.
  posterFallbackCenter: {
    alignItems: "center",
    justifyContent: "center",
  },
  // Muted monogram glyph — matches the stripe's neutral palette
  // (textTertiary #766f64 on mapEmptyStart #e9e5dd): subtle, not loud.
  posterMonogram: {
    fontSize: 16,
    color: colors.textTertiary,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "transparent",
  },
  itemPressed: {
    backgroundColor: colors.cardMutedBg,
    borderColor: colors.borderSoft,
  },
  itemLabelError: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  itemLabel: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  // UI42.4 — title + expectation badge sit side by side, wrapping on narrow rows.
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  badgeAmc: {
    backgroundColor: colors.amberTagBg,
  },
  badgeUnverified: {
    backgroundColor: colors.mapEmptyStart,
  },
  badgeText: {
    fontSize: 11,
  },
  badgeTextAmc: {
    color: colors.amberTagText,
  },
  badgeTextUnverified: {
    color: colors.textTertiary,
  },
  // UI42.6 — dropdown footer CTA below the suggestion list.
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    gap: 4,
  },
  // Cold Mode prominence for the live-schedule check.
  footerCold: {
    backgroundColor: colors.theaterConfirmBg,
  },
  footerText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  footerLink: {
    fontSize: 12,
    color: colors.brandDark,
  },
  // UI42.6 — failure line for the on-demand refresh, below the footer CTA.
  footerErrorWrap: {
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  footerError: {
    fontSize: 12,
    color: colors.noValidText,
  },
  itemLabelMuted: {
    fontSize: 14,
    color: colors.textTertiary,
  },
  deadEndRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  forwardAction: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  forwardActionText: {
    fontSize: 12,
    color: colors.brandDark,
  },
  countLabel: {
    fontSize: 12,
    color: colors.textTertiary,
    marginLeft: 8,
  },
  itemDisabled: {
    opacity: 0.5,
  },
});
