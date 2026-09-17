import { useState, type ReactElement } from "react";
import { Image, StyleSheet, Platform, Pressable, TextInput, View } from "react-native";
import { colors } from "@/theme/colors";
import { fontFamily } from "@/theme/typography";
import type { MovieSuggestion } from "@/hooks/viewModels/useSubmitSearchViewModel";
import { AppText } from "@/components/core/AppText";
import { AutocompleteFieldShell, AutocompletePopover } from "@/components/core/Autocomplete";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import { getFacetDisplay, shouldDimFacet } from "@/lib/facetCounts";

function MoviePoster({ posterUrl }: { posterUrl: string | null | undefined }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (posterUrl == null || posterUrl === "" || failed) {
    return (
      <View
        style={[styles.poster, styles.posterFallback]}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
      />
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
}: MovieFieldProps): ReactElement {
  void onGateClick;
  const effectiveTotal =
    totalTheatres ??
    (movieCounts
      ? movieCounts instanceof Map
        ? movieCounts.size
        : Object.keys(movieCounts).length
      : 1);
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
                    return (
                      <Pressable
                        key={i}
                        onPress={isRowDisabled ? undefined : item.onPress}
                        disabled={isRowDisabled}
                        accessibilityRole="menuitem"
                        accessibilityLabel={`${item.label}${countText ? `, ${countText}` : ""}`}
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
                        <MoviePoster posterUrl={item.posterUrl} />
                        <View style={{ flex: 1, gap: 2 }}>
                          <AppText style={[styles.itemLabel, warmZero && { opacity: 0.5 }]}>
                            {item.label}
                          </AppText>
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
                </View>
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
                  {movieSuggestions.map((item, i) => (
                    <Pressable
                      key={i}
                      onPress={isLocked ? undefined : item.onPress}
                      disabled={!!isLocked}
                      accessibilityRole="menuitem"
                      accessibilityLabel={item.label}
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
                      <MoviePoster posterUrl={item.posterUrl} />
                      <AppText style={[styles.itemLabel, { flex: 1 }]}>{item.label}</AppText>
                    </Pressable>
                  ))}
                </View>
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
    maxHeight: 326,
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
