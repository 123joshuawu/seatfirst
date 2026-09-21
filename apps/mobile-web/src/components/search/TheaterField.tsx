import React from "react";
import type { ReactElement } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { colors } from "@/theme/colors";
import { fontFamily } from "@/theme/typography";
import { AppText } from "@/components/core/AppText";
import { Checkbox } from "@/components/core/Checkbox";
import { AutocompletePopover } from "@/components/core/Autocomplete";
import { EyebrowLabel } from "@/components/core/EyebrowLabel";
import {
  useWhereFieldViewModel,
  RADIUS_OPTIONS,
  formatRadius,
  formatRadiusSpoken,
  getHitCity,
  getHitDistance,
  getHitId,
  getHitName,
  getPlaceOptionKey,
  getTheatreOptionKey,
  getWhereOptionId,
} from "@/hooks/viewModels/useWhereFieldViewModel";
import type { WhereListItem } from "@/hooks/viewModels/useWhereFieldViewModel";
import type { GeocodeResolver, SuggestPlaceResolver } from "@/lib/geocodeSeam";
import { getFacetDisplay, shouldDimFacet } from "@/lib/facetCounts";
import { formatUsPlaceLabel } from "@/lib/placeLabel";

export interface TheaterFieldProps {
  isLocked?: boolean;
  theatreCounts?: Map<string, { count: number; coldTheatreCount: number }> | undefined;
  warmZeroTheatreIds?: Set<string> | undefined;
  onWidenWindow?: (() => void) | undefined;
  /** Test seam; production defaults to the tRPC-backed resolver. */
  geocodeResolver?: GeocodeResolver;
  /** Test seam; production defaults to the tRPC-backed resolver. */
  suggestPlaceResolver?: SuggestPlaceResolver;
  /**
   * Mobile override — forwards to the suggestion popovers so the list renders
   * as a bottom sheet. Defaults to the shared viewport check (width < 680,
   * same as `vm.isMobile`).
   */
  isMobile?: boolean;
}

export function TheaterField({
  isLocked = false,
  theatreCounts,
  warmZeroTheatreIds,
  onWidenWindow,
  geocodeResolver,
  suggestPlaceResolver,
  isMobile,
}: TheaterFieldProps): ReactElement {
  const vm = useWhereFieldViewModel({
    isLocked,
    ...(geocodeResolver ? { geocodeResolver } : {}),
    ...(suggestPlaceResolver ? { suggestPlaceResolver } : {}),
  });
  const inputRef = React.useRef<TextInput>(null);
  // ASD-STE100: warm-zero rows render dimmed with an "Any time →" dead-end
  // action instead of a checkbox toggle; the select-all bulk action below
  // must skip exactly these rows, so both paths share this predicate.
  const getTheatreCountEntry = (id: string) => {
    if (!theatreCounts) return undefined;
    if (theatreCounts instanceof Map) return theatreCounts.get(id);
    return (theatreCounts as Record<string, { count: number; coldTheatreCount: number }>)[id];
  };
  const isWarmZeroTheatre = (hit: WhereListItem): boolean => {
    const id = getHitId(hit);
    return warmZeroTheatreIds?.has(id) || shouldDimFacet(getTheatreCountEntry(id), 1);
  };
  // UI37 select-all scope: exactly the rows the toggle will add/remove —
  // currently-visible theatres minus the warm-zero-disabled ones (which keep
  // their dead-end action instead). Locked state disables the toggle via the
  // Pressable below, not by shrinking this list.
  const selectableTheatreHits = vm.theatres.filter((hit) => !isWarmZeroTheatre(hit));
  const allSelectableTheatresSelected =
    selectableTheatreHits.length > 0 &&
    selectableTheatreHits.every((hit) =>
      vm.selectedTheatres.some((theatre) => theatre.id === getHitId(hit)),
    );
  // UI37 radius retry target: the next-larger radius option, if any.
  const widenRadiusTarget =
    RADIUS_OPTIONS.find((option) => option.valueKm > vm.whereRadiusKm) ?? null;
  const renderSelectableTheatreRows = () =>
    vm.theatres.map((hit, idx) => {
      const id = getTheatreOptionKey(hit).slice("theatre:".length);
      const selected = vm.selectedTheatres.some((theatre) => theatre.id === id);
      const distanceKm = getHitDistance(hit);
      const distanceLabel =
        distanceKm !== null && Number.isFinite(distanceKm)
          ? `${(distanceKm * 0.621371).toFixed(1)} mi`
          : null;
      const entry = getTheatreCountEntry(id);
      const display = entry ? getFacetDisplay(entry, 1) : null;
      const warmZero = warmZeroTheatreIds?.has(id) || shouldDimFacet(entry, 1);
      const isRowDisabled = isLocked || warmZero;
      const isActive = vm.activeKey === getTheatreOptionKey(hit);
      const countLabel = display?.text ?? null;

      return (
        <View
          key={`${id}-${idx}`}
          style={[
            styles.item,
            styles.theatreRow,
            isActive && styles.itemActive,
            isRowDisabled && styles.itemDisabled,
            warmZero && onWidenWindow ? styles.deadEndRow : undefined,
            warmZero ? { opacity: 0.5 } : undefined,
          ]}
        >
          <Pressable
            onPress={isRowDisabled ? undefined : () => vm.actions.handleSelectTheatre(hit)}
            disabled={isRowDisabled}
            accessibilityRole="checkbox"
            accessibilityLabel={`${getHitName(hit)}${distanceLabel ? `, ${distanceLabel}` : ""}${selected ? ", selected" : ""}${countLabel ? `, ${countLabel}` : ""}`}
            accessibilityState={{ checked: selected, disabled: isRowDisabled }}
            accessibilityHint={selected ? "Deselects theatre" : "Selects theatre"}
            focusable={!isRowDisabled}
            {...(Platform.OS === "web"
              ? ({
                  role: "option",
                  id: getWhereOptionId(getTheatreOptionKey(hit)),
                  "aria-selected": selected ? "true" : "false",
                  "aria-disabled": isRowDisabled ? "true" : undefined,
                } as unknown as Record<string, unknown>)
              : {})}
            style={styles.selectableTheatre}
          >
            <View style={styles.theatreRowLeft}>
              {/* UI33 shared Checkbox (non-standalone: the outer Pressable keeps
              the row's checkbox role, label, hint, and active-id wiring). */}
              <Checkbox size="sm" checked={selected} standalone={false} />
              <View style={styles.theatreTextWrap}>
                <AppText style={[styles.itemLabel, selected && { fontWeight: "600" }]}>
                  {getHitName(hit)}
                </AppText>
                {getHitCity(hit) ? (
                  <AppText weight="400" style={styles.itemCity}>
                    {getHitCity(hit)}
                  </AppText>
                ) : null}
              </View>
            </View>
            {distanceLabel ? <AppText style={styles.distanceLabel}>{distanceLabel}</AppText> : null}
            {countLabel ? (
              <AppText style={styles.distanceLabel}>
                {countLabel === "not checked yet"
                  ? countLabel
                  : `${countLabel} showtime${countLabel === "1" ? "" : "s"}`}
              </AppText>
            ) : null}
          </Pressable>
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
                Any time →
              </AppText>
            </Pressable>
          ) : null}
        </View>
      );
    });
  const trimmedQuery = vm.inputValue.trim();
  const emptyPlacesSubhead =
    trimmedQuery.length === 0
      ? "Use your location, or type a city, neighborhood, or address"
      : vm.suggestCandidates.length > 0
        ? `Selects every AMC within ${formatRadius(vm.whereRadiusKm)}`
        : `No places match “${trimmedQuery}”`;

  // Desktop (isMobile === false) renders the same fields with tighter vertical
  // rhythm so the form CTA clears ~900px viewports. `undefined` (no override
  // passed) keeps the long-standing mobile values.
  const desktop = isMobile === false;
  return (
    <View style={{ marginBottom: desktop ? 12 : 20, zIndex: 3 }}>
      <View style={styles.labelRow}>
        <EyebrowLabel marginBottom={desktop ? 6 : 8}>Where</EyebrowLabel>
        {vm.whereFieldMode !== "empty" ? (
          <Pressable
            onPress={isLocked ? undefined : vm.actions.handleClearWhere}
            disabled={isLocked}
            accessibilityRole="button"
            accessibilityLabel="Clear the Where field"
            accessibilityHint="Removes the place or theatres you selected"
            focusable={!isLocked}
            style={styles.clearButton}
          >
            <AppText weight="600" style={styles.clearButtonText}>
              Clear
            </AppText>
          </Pressable>
        ) : null}
      </View>

      <View style={{ zIndex: 10 }}>
        <View
          style={[
            styles.tokenfield,
            desktop && styles.tokenfieldDesktop,
            vm.showDropdown && styles.tokenfieldFocused,
            isLocked && styles.tokenfieldDisabled,
          ]}
        >
          {(vm.showPlaceChip || vm.showDeviceChip || vm.showTheatreChips) && (
            <View style={styles.chipsInside}>
              {vm.showPlaceChip && (
                <Pressable
                  onPress={isLocked ? undefined : vm.actions.handleRemovePlaceChip}
                  disabled={isLocked}
                  accessibilityRole="button"
                  accessibilityLabel={
                    vm.wherePlace
                      ? `Remove place ${formatUsPlaceLabel(vm.wherePlace.resolvedPlaceName ?? vm.wherePlace.query)}, within ${formatRadiusSpoken(vm.wherePlace.radiusKm)}`
                      : "Remove place"
                  }
                  accessibilityHint="Removes the place and every theatre it selected"
                  focusable={!isLocked}
                  style={styles.chipInside}
                >
                  <AppText
                    weight="500"
                    style={styles.chipInsideText}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {vm.placeChipLabel}
                  </AppText>
                  <AppText weight="700" style={styles.chipRemove}>
                    ×
                  </AppText>
                </Pressable>
              )}
              {vm.showDeviceChip && (
                <Pressable
                  onPress={isLocked ? undefined : vm.actions.handleRemovePlaceChip}
                  disabled={isLocked}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove current location, within ${formatRadiusSpoken(vm.whereRadiusKm)}`}
                  accessibilityHint="Removes device location selection"
                  focusable={!isLocked}
                  style={styles.chipInside}
                >
                  <AppText
                    weight="500"
                    style={styles.chipInsideText}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {vm.deviceChipLabel}
                  </AppText>
                  <AppText weight="700" style={styles.chipRemove}>
                    ×
                  </AppText>
                </Pressable>
              )}
              {vm.showTheatreChips &&
                vm.selectedTheatres.map((ref) => (
                  <Pressable
                    key={ref.id}
                    onPress={
                      isLocked ? undefined : () => vm.actions.handleRemoveTheatreChip(ref.id)
                    }
                    disabled={isLocked}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${ref.name ?? "selected theatre"}`}
                    accessibilityHint="Removes theatre selection"
                    focusable={!isLocked}
                    style={styles.chipInside}
                  >
                    <AppText
                      weight="500"
                      style={styles.chipInsideText}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {ref.name ?? "Selected theatre"}
                    </AppText>
                    <AppText weight="700" style={styles.chipRemove}>
                      ×
                    </AppText>
                  </Pressable>
                ))}
            </View>
          )}

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              nativeID="seatfirst-where"
              value={vm.inputValue}
              onChangeText={isLocked ? undefined : vm.actions.handleChangeText}
              onFocus={isLocked ? undefined : vm.actions.handleFocus}
              onBlur={vm.actions.handleBlur}
              placeholder={
                vm.whereFieldMode === "place"
                  ? "Search for a different place"
                  : vm.whereFieldMode === "theatres"
                    ? "+ Add theatre"
                    : "Add a place or theatre"
              }
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.input,
                desktop && styles.inputDesktop,
                isLocked && styles.inputDisabled,
              ]}
              editable={!isLocked}
              selectTextOnFocus={!isLocked}
              accessibilityLabel="Where — place or theatre"
              accessibilityHint="Type a place or theatre name, or use current location"
              accessibilityState={{ disabled: !!isLocked, expanded: !!vm.showDropdown }}
              onKeyPress={(e) => vm.actions.handleKeyDown(e, inputRef)}
              {...(Platform.OS === "web"
                ? ({
                    id: "seatfirst-where",
                    name: "where",
                  } as unknown as Record<string, unknown>)
                : {})}
              {...vm.inputAriaProps}
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
        </View>

        {/* A place lookup error supersedes the suggestions for the failed query:
        `showDropdown` is focus-driven so it stays true while the error stands,
        and the desktop popover (position:absolute, zIndex 10 inside the zIndex:10
        wrapper above) paints over the in-flow inline error below it, hiding it.
        Suppressing the popover also dismisses the mobile bottom-sheet Modal,
        leaving the single inline error. Typing or refocusing clears the error
        (handleChangeText/handleFocus call clearPlaceError) and reopens the dropdown. */}
        {vm.showDropdown && !vm.placeError ? (
          vm.whereFieldMode === "place" ? (
            <AutocompletePopover
              id="where-place-panel"
              header="Place search and radius"
              ariaLabel="Place search and radius"
              renderHeader={false}
              role="region"
              isMobile={isMobile}
              onClose={vm.actions.handleBlur}
            >
              <View style={styles.panelHeader}>
                <AppText weight="600" style={styles.panelKicker}>
                  Searching around
                </AppText>
                <AppText weight="600" style={styles.panelPlaceName}>
                  {vm.wherePlace
                    ? formatUsPlaceLabel(vm.wherePlace.resolvedPlaceName ?? vm.wherePlace.query)
                    : "Current location"}
                </AppText>
              </View>

              <View style={styles.panelRadius}>
                <AppText weight="600" style={styles.panelRadiusLabel}>
                  Radius
                </AppText>
                <View style={styles.panelRadiusOptions}>
                  {RADIUS_OPTIONS.map((option) => {
                    const isActive = vm.whereRadiusKm === option.valueKm;
                    return (
                      <Pressable
                        key={option.label}
                        onPress={
                          isLocked ? undefined : () => vm.actions.setWhereRadiusKm(option.valueKm)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={`${option.label} radius`}
                        accessibilityState={{ selected: isActive, disabled: isLocked }}
                        focusable={!isLocked}
                        style={[
                          styles.radiusChip,
                          isActive ? styles.radiusChipActive : styles.radiusChipInactive,
                          isLocked && styles.radiusChipDisabled,
                        ]}
                      >
                        <AppText
                          weight={isActive ? "700" : "500"}
                          style={[
                            styles.radiusChipText,
                            isActive ? styles.radiusChipTextActive : undefined,
                          ]}
                        >
                          {option.label}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {trimmedQuery.length > 0 ? (
                <View style={styles.panelSection}>
                  <AppText weight="700" style={styles.groupHeading}>
                    Places
                  </AppText>
                  <AppText style={styles.placesSubhead}>
                    Picking one replaces{" "}
                    {vm.wherePlace
                      ? formatUsPlaceLabel(vm.wherePlace.resolvedPlaceName ?? vm.wherePlace.query)
                      : "Current location"}
                  </AppText>
                  {vm.suggestCandidates.length > 0 ? (
                    vm.suggestCandidates.map((candidate, index) => (
                      <Pressable
                        key={`${candidate.label}-${index}`}
                        onPress={
                          isLocked ? undefined : () => vm.actions.handleSelectCandidate(candidate)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={formatUsPlaceLabel(candidate.label)}
                        accessibilityState={{ disabled: isLocked }}
                        focusable={!isLocked}
                        style={[styles.item, styles.theatreRow, isLocked && styles.itemDisabled]}
                      >
                        <View style={styles.theatreRowLeft}>
                          <View
                            accessible={false}
                            importantForAccessibility="no"
                            style={[styles.checkbox, styles.pinSlot]}
                          >
                            <AppText weight="800" style={styles.pinGlyph}>
                              📍
                            </AppText>
                          </View>
                          <AppText style={styles.itemLabel}>
                            {formatUsPlaceLabel(candidate.label)}
                          </AppText>
                        </View>
                      </Pressable>
                    ))
                  ) : (
                    <View style={styles.item}>
                      <AppText style={styles.itemLabelMuted}>
                        No places match “{trimmedQuery}”
                      </AppText>
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.panelSection}>
                  <AppText weight="700" style={styles.groupHeading}>
                    {`${vm.selectedTheatres.length} theatre${vm.selectedTheatres.length === 1 ? "" : "s"} in range`}
                  </AppText>
                  {vm.selectedTheatres.length > 0 ? (
                    vm.selectedTheatres.map((theatre) => {
                      const distanceKm = getHitDistance(theatre);
                      const distanceLabel =
                        distanceKm !== null && Number.isFinite(distanceKm)
                          ? `${(distanceKm * 0.621371).toFixed(1)} mi`
                          : null;
                      return (
                        <View
                          key={theatre.id}
                          style={[styles.item, styles.theatreRow, styles.readonlyTheatre]}
                        >
                          <View style={styles.theatreRowLeft}>
                            <View
                              accessible={false}
                              importantForAccessibility="no"
                              style={[styles.checkbox, styles.pinSlot]}
                            >
                              <AppText weight="800" style={styles.readonlyMarker}>
                                ·
                              </AppText>
                            </View>
                            <View style={styles.theatreTextWrap}>
                              <AppText style={styles.itemLabel}>{getHitName(theatre)}</AppText>
                              {getHitCity(theatre) ? (
                                <AppText weight="400" style={styles.itemCity}>
                                  {getHitCity(theatre)}
                                </AppText>
                              ) : null}
                            </View>
                          </View>
                          {distanceLabel ? (
                            <AppText style={styles.distanceLabel}>{distanceLabel}</AppText>
                          ) : null}
                        </View>
                      );
                    })
                  ) : (
                    <View style={styles.item}>
                      <AppText style={styles.itemLabelMuted}>No theatres found in range</AppText>
                    </View>
                  )}
                </View>
              )}

              <View style={styles.panelFooter}>
                <Pressable
                  onPress={isLocked ? undefined : vm.actions.handleUseLocation}
                  disabled={isLocked || vm.geolocationBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Use my location instead"
                  accessibilityHint="Swaps the centre and keeps the radius"
                  accessibilityState={{ disabled: isLocked, busy: vm.geolocationBusy }}
                  focusable={!isLocked}
                  style={[styles.footerAction, isLocked && styles.itemDisabled]}
                >
                  <AppText weight="600" style={styles.footerActionText}>
                    Use my location instead →
                  </AppText>
                  <AppText style={styles.footerActionSubhead}>
                    Stays in place mode — swaps the centre, keeps the radius
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={isLocked ? undefined : vm.actions.handleConvertWherePlaceToTheatres}
                  disabled={isLocked}
                  accessibilityRole="button"
                  accessibilityLabel="Pick theatres instead"
                  accessibilityHint="Turns resolved theatres into individual picks"
                  focusable={!isLocked}
                  style={[styles.footerAction, isLocked && styles.itemDisabled]}
                >
                  <AppText weight="600" style={styles.footerActionText}>
                    Pick theatres instead →
                  </AppText>
                  <AppText style={styles.footerActionSubhead}>
                    Turns these {vm.selectedTheatres.length} into individual picks and drops the
                    place
                  </AppText>
                </Pressable>
              </View>
            </AutocompletePopover>
          ) : (
            <AutocompletePopover
              id="where-listbox"
              header="Places and theatres"
              ariaLabel="Places and theatres"
              renderHeader={false}
              isMobile={isMobile}
              onClose={vm.actions.handleBlur}
            >
              {vm.whereFieldMode === "empty" && !vm.theatresFirst ? (
                <View
                  style={styles.placesGroup}
                  {...(Platform.OS === "web"
                    ? ({
                        role: "group",
                        "aria-labelledby": "where-group-places",
                      } as unknown as Record<string, unknown>)
                    : {})}
                >
                  <AppText
                    weight="700"
                    style={styles.groupHeading}
                    {...(Platform.OS === "web"
                      ? ({
                          id: "where-group-places",
                          role: "presentation",
                        } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    Places
                  </AppText>
                  <AppText
                    style={styles.placesSubhead}
                    {...(Platform.OS === "web"
                      ? ({ role: "presentation" } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    {emptyPlacesSubhead}
                  </AppText>
                  {trimmedQuery.length > 0 &&
                  vm.suggestCandidates.length === 0 &&
                  vm.theatres.length === 0 &&
                  !vm.isSearching &&
                  !vm.effectiveTheatreSearchError ? (
                    <View style={styles.item}>
                      <AppText style={styles.itemLabelMuted}>No matching locations found</AppText>
                    </View>
                  ) : null}
                  <Pressable
                    onPress={isLocked ? undefined : vm.actions.handleUseLocation}
                    disabled={isLocked || vm.geolocationBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Use my location"
                    accessibilityState={{ disabled: isLocked, busy: vm.geolocationBusy }}
                    focusable={!isLocked}
                    {...(Platform.OS === "web"
                      ? ({
                          role: "option",
                          "aria-disabled": isLocked ? "true" : undefined,
                        } as unknown as Record<string, unknown>)
                      : {})}
                    style={[styles.item, styles.theatreRow, isLocked && styles.itemDisabled]}
                  >
                    <View style={styles.theatreRowLeft}>
                      <View
                        accessible={false}
                        importantForAccessibility="no"
                        style={[styles.checkbox, styles.pinSlot]}
                      >
                        <AppText weight="800" style={styles.pinGlyph}>
                          📍
                        </AppText>
                      </View>
                      <AppText
                        style={[styles.itemLabel, { color: colors.brandDark, fontWeight: "600" }]}
                      >
                        {vm.geolocationBusy ? "Locating…" : "Use my location"}
                      </AppText>
                    </View>
                  </Pressable>
                  {vm.suggestCandidates.map((candidate, index) => {
                    const optionKey = getPlaceOptionKey(index);
                    const isActive = vm.activeKey === optionKey;
                    return (
                      <Pressable
                        key={`${candidate.label}-${index}`}
                        onPress={
                          isLocked ? undefined : () => vm.actions.handleSelectCandidate(candidate)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={formatUsPlaceLabel(candidate.label)}
                        accessibilityState={{ selected: isActive, disabled: isLocked }}
                        focusable={!isLocked}
                        {...(Platform.OS === "web"
                          ? ({
                              role: "option",
                              id: getWhereOptionId(optionKey),
                              "aria-selected": isActive ? "true" : "false",
                              "aria-disabled": isLocked ? "true" : undefined,
                            } as unknown as Record<string, unknown>)
                          : {})}
                        style={[
                          styles.item,
                          styles.theatreRow,
                          isActive && styles.itemActive,
                          isLocked && styles.itemDisabled,
                        ]}
                      >
                        <View style={styles.theatreRowLeft}>
                          <View
                            accessible={false}
                            importantForAccessibility="no"
                            style={[styles.checkbox, styles.pinSlot]}
                          >
                            <AppText weight="800" style={styles.pinGlyph}>
                              📍
                            </AppText>
                          </View>
                          <AppText style={styles.itemLabel}>
                            {formatUsPlaceLabel(candidate.label)}
                          </AppText>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              <View
                {...(Platform.OS === "web"
                  ? ({
                      role: "group",
                      "aria-labelledby": "where-group-theatres",
                    } as unknown as Record<string, unknown>)
                  : {})}
              >
                <AppText
                  weight="700"
                  style={styles.groupHeading}
                  {...(Platform.OS === "web"
                    ? ({
                        id: "where-group-theatres",
                        role: "presentation",
                      } as unknown as Record<string, unknown>)
                    : {})}
                >
                  AMC theaters
                </AppText>
                {vm.effectiveTheatreSearchError ? (
                  <View
                    style={styles.item}
                    accessibilityRole="alert"
                    {...(Platform.OS === "web"
                      ? ({ role: "alert" } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    <AppText style={styles.itemLabel}>{vm.effectiveTheatreSearchError}</AppText>
                  </View>
                ) : vm.isSearching ? (
                  <View
                    style={styles.item}
                    accessibilityLiveRegion="polite"
                    {...(Platform.OS === "web"
                      ? ({ role: "status" } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    <AppText style={styles.itemLabelMuted}>Searching…</AppText>
                  </View>
                ) : vm.theatres.length > 0 ? (
                  <>
                    {/* UI37 select-all: toggles every currently-visible
                    selectable theatre (warm-zero-disabled rows excluded).
                    Styled as a small heading-adjacent text button, matching
                    the file's clearButton/footer-action visual language. */}
                    {selectableTheatreHits.length > 0 ? (
                      <Pressable
                        onPress={
                          isLocked
                            ? undefined
                            : () =>
                                allSelectableTheatresSelected
                                  ? vm.actions.handleDeselectAllTheatres(selectableTheatreHits)
                                  : vm.actions.handleSelectAllTheatres(selectableTheatreHits)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={
                          allSelectableTheatresSelected
                            ? "Deselect all theatres"
                            : "Select all theatres"
                        }
                        accessibilityHint={
                          allSelectableTheatresSelected
                            ? "Clears every visible theatre selection"
                            : "Selects every visible theatre"
                        }
                        accessibilityState={{ disabled: isLocked }}
                        focusable={!isLocked}
                        style={[styles.selectAllRow, isLocked && styles.itemDisabled]}
                      >
                        <AppText weight="600" style={styles.selectAllText}>
                          {allSelectableTheatresSelected ? "Deselect all" : "Select all"}
                        </AppText>
                      </Pressable>
                    ) : null}
                    {renderSelectableTheatreRows()}
                  </>
                ) : (
                  <View style={styles.item}>
                    <AppText style={styles.itemLabelMuted}>
                      {trimmedQuery.length > 0
                        ? `No theatre matches “${trimmedQuery}”`
                        : "No theatres found"}
                    </AppText>
                    {/* UI37 radius retry: a zero-result theatre search can retry
                    at the next-larger radius without leaving theatre mode, via
                    the same setWhereRadiusKm primitive as the place-panel
                    chips. Hidden once the radius is already at its maximum. */}
                    {widenRadiusTarget ? (
                      <Pressable
                        onPress={
                          isLocked
                            ? undefined
                            : () => vm.actions.setWhereRadiusKm(widenRadiusTarget.valueKm)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={`Widen radius to ${widenRadiusTarget.label}`}
                        accessibilityHint="Retries the theatre search at a larger radius"
                        accessibilityState={{ disabled: isLocked }}
                        focusable={!isLocked}
                        style={[styles.retryAction, isLocked && styles.itemDisabled]}
                      >
                        <AppText weight="600" style={styles.retryActionText}>
                          Widen radius to {widenRadiusTarget.label} →
                        </AppText>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </View>
              {vm.whereFieldMode === "empty" && vm.theatresFirst ? (
                <View
                  style={styles.placesGroup}
                  {...(Platform.OS === "web"
                    ? ({
                        role: "group",
                        "aria-labelledby": "where-group-places",
                      } as unknown as Record<string, unknown>)
                    : {})}
                >
                  <AppText
                    weight="700"
                    style={styles.groupHeading}
                    {...(Platform.OS === "web"
                      ? ({
                          id: "where-group-places",
                          role: "presentation",
                        } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    Places
                  </AppText>
                  <AppText
                    style={styles.placesSubhead}
                    {...(Platform.OS === "web"
                      ? ({ role: "presentation" } as unknown as Record<string, unknown>)
                      : {})}
                  >
                    {emptyPlacesSubhead}
                  </AppText>
                  {trimmedQuery.length > 0 &&
                  vm.suggestCandidates.length === 0 &&
                  vm.theatres.length === 0 &&
                  !vm.isSearching &&
                  !vm.effectiveTheatreSearchError ? (
                    <View style={styles.item}>
                      <AppText style={styles.itemLabelMuted}>No matching locations found</AppText>
                    </View>
                  ) : null}
                  <Pressable
                    onPress={isLocked ? undefined : vm.actions.handleUseLocation}
                    disabled={isLocked || vm.geolocationBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Use my location"
                    accessibilityState={{ disabled: isLocked, busy: vm.geolocationBusy }}
                    focusable={!isLocked}
                    {...(Platform.OS === "web"
                      ? ({
                          role: "option",
                          "aria-disabled": isLocked ? "true" : undefined,
                        } as unknown as Record<string, unknown>)
                      : {})}
                    style={[styles.item, styles.theatreRow, isLocked && styles.itemDisabled]}
                  >
                    <View style={styles.theatreRowLeft}>
                      <View
                        accessible={false}
                        importantForAccessibility="no"
                        style={[styles.checkbox, styles.pinSlot]}
                      >
                        <AppText weight="800" style={styles.pinGlyph}>
                          📍
                        </AppText>
                      </View>
                      <AppText
                        style={[styles.itemLabel, { color: colors.brandDark, fontWeight: "600" }]}
                      >
                        {vm.geolocationBusy ? "Locating…" : "Use my location"}
                      </AppText>
                    </View>
                  </Pressable>
                  {vm.suggestCandidates.map((candidate, index) => {
                    const optionKey = getPlaceOptionKey(index);
                    const isActive = vm.activeKey === optionKey;
                    return (
                      <Pressable
                        key={`${candidate.label}-${index}`}
                        onPress={
                          isLocked ? undefined : () => vm.actions.handleSelectCandidate(candidate)
                        }
                        disabled={isLocked}
                        accessibilityRole="button"
                        accessibilityLabel={formatUsPlaceLabel(candidate.label)}
                        accessibilityState={{ selected: isActive, disabled: isLocked }}
                        focusable={!isLocked}
                        {...(Platform.OS === "web"
                          ? ({
                              role: "option",
                              id: getWhereOptionId(optionKey),
                              "aria-selected": isActive ? "true" : "false",
                              "aria-disabled": isLocked ? "true" : undefined,
                            } as unknown as Record<string, unknown>)
                          : {})}
                        style={[
                          styles.item,
                          styles.theatreRow,
                          isActive && styles.itemActive,
                          isLocked && styles.itemDisabled,
                        ]}
                      >
                        <View style={styles.theatreRowLeft}>
                          <View
                            accessible={false}
                            importantForAccessibility="no"
                            style={[styles.checkbox, styles.pinSlot]}
                          >
                            <AppText weight="800" style={styles.pinGlyph}>
                              📍
                            </AppText>
                          </View>
                          <AppText style={styles.itemLabel}>
                            {formatUsPlaceLabel(candidate.label)}
                          </AppText>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {vm.whereFieldMode === "theatres" && vm.showPlaceSignpost ? (
                <Pressable
                  onPress={isLocked ? undefined : vm.actions.handleFollowPlaceSignpost}
                  disabled={isLocked}
                  accessibilityRole="button"
                  accessibilityLabel="Looking for a place?"
                  accessibilityHint="Clears your theatre selections so you can search places instead"
                  focusable={!isLocked}
                  style={[styles.signpost, isLocked && styles.itemDisabled]}
                >
                  <AppText weight="600" style={styles.footerActionText}>
                    Looking for a place? →
                  </AppText>
                  <AppText style={styles.footerActionSubhead}>
                    Clears your {vm.selectedTheatres.length} theatre
                    {vm.selectedTheatres.length === 1 ? "" : "s"} so you can search places instead
                  </AppText>
                </Pressable>
              ) : null}
            </AutocompletePopover>
          )
        ) : null}
      </View>

      {vm.geolocationError ? (
        <View style={styles.inlineError} accessibilityRole="alert">
          <AppText weight="400" style={styles.inlineErrorText}>
            {vm.geolocationError}
          </AppText>
        </View>
      ) : null}
      {vm.placeError ? (
        <View style={styles.inlineError} accessibilityRole="alert">
          <AppText weight="400" style={styles.inlineErrorText}>
            {vm.placeError}
          </AppText>
          {vm.placeErrorKind === "PLACE_NOT_FOUND" ? (
            <AppText weight="400" style={styles.inlineErrorHint}>
              Try a different address, neighborhood, or city.
            </AppText>
          ) : vm.placeErrorKind === "PLACE_RESOLUTION_UNAVAILABLE" ? (
            <AppText weight="400" style={styles.inlineErrorHint}>
              Please try again in a moment.
            </AppText>
          ) : null}
        </View>
      ) : null}
      {vm.isResolvingPlace ? (
        <View style={styles.inlineResolving}>
          <AppText weight="400" style={styles.inlineResolvingText}>
            Finding theatres…
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  clearButton: {
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  clearButtonText: {
    fontSize: 13,
    color: colors.brandDark,
  },
  // UI37 select-all toggle: small heading-adjacent text button, matching the
  // clearButton/footer-action visual language (13px semibold brandDark).
  selectAllRow: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignSelf: "flex-start",
  },
  selectAllText: {
    fontSize: 13,
    color: colors.brandDark,
  },
  // UI37 radius retry inside the theatre empty state: same text-button idiom.
  retryAction: {
    paddingTop: 8,
    alignSelf: "flex-start",
  },
  retryActionText: {
    fontSize: 13,
    color: colors.brandDark,
  },
  tokenfield: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.cardMutedBg,
    padding: 7,
    gap: 6,
  },
  // Desktop (≥680px): 1px less wrap padding; pairs with the tighter section gaps.
  tokenfieldDesktop: {
    padding: 6,
  },
  tokenfieldFocused: {
    borderColor: colors.brandDark,
  },
  tokenfieldDisabled: {
    opacity: 0.5,
  },
  chipsInside: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chipInside: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingLeft: 11,
    paddingRight: 8,
    borderRadius: 999,
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  // One very long place/theatre name must not dominate the row: cap the label
  // width and ellipsize (numberOfLines={1} at each call site) so sibling chips
  // and the input row keep usable space. Without the cap a single chip takes
  // its full intrinsic width and squeezes the input's placeholder unreadable.
  chipInsideText: {
    fontSize: 13,
    color: colors.brandDark,
    maxWidth: 220,
  },
  chipRemove: {
    fontSize: 16,
    color: colors.brandDark,
    lineHeight: 16,
  },
  // minWidth floor (not 0): once the chips leave less than a usable width, the
  // tokenfield's flexWrap wraps this row onto its own line instead of crushing
  // the placeholder down to a few characters. Previously minWidth: 0 let the
  // row collapse to near-nothing beside a long chip ("Search fo…") and the
  // wrap point shifted between renders, causing a visible layout jump.
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 120,
  },
  // The input keeps its own minWidth: 0 so text truncates *inside* the row's
  // guaranteed 120px floor above rather than forcing the row wider.
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 5,
    paddingHorizontal: 6,
    fontSize: 15,
    fontWeight: "500",
    fontFamily: fontFamily.bodyMedium,
    color: colors.textPrimary,
  },
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
  panelHeader: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: colors.gateBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderHairline,
    gap: 2,
  },
  panelKicker: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.textTertiary,
  },
  panelPlaceName: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  panelRadius: {
    padding: 14,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  panelRadiusLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.textTertiary,
  },
  panelRadiusOptions: {
    flexDirection: "row",
    gap: 8,
  },
  radiusChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  radiusChipActive: {
    backgroundColor: colors.brandDark,
    borderColor: colors.brandDark,
  },
  radiusChipInactive: {
    backgroundColor: colors.cardBg,
    borderColor: colors.borderSoft,
  },
  radiusChipDisabled: {
    opacity: 0.45,
  },
  radiusChipText: {
    fontSize: 13,
    color: colors.textPrimary,
  },
  radiusChipTextActive: {
    color: colors.white,
  },
  panelSection: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
  },
  panelFooter: {
    gap: 1,
  },
  footerAction: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    gap: 3,
  },
  footerActionText: {
    fontSize: 13,
    color: colors.brandDark,
  },
  footerActionSubhead: {
    fontSize: 12,
    color: colors.textMuted,
  },
  readonlyTheatre: {
    backgroundColor: colors.cardMutedBg,
  },
  readonlyMarker: {
    fontSize: 18,
    lineHeight: 18,
    color: colors.textTertiary,
  },
  signpost: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    gap: 3,
  },
  inlineError: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.noValidBg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: 4,
  },
  inlineErrorText: {
    fontSize: 13,
    color: colors.noValidText,
  },
  inlineErrorHint: {
    fontSize: 12,
    color: colors.textMuted,
  },
  inlineResolving: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineResolvingText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  groupHeading: {
    paddingTop: 8,
    paddingHorizontal: 14,
    paddingBottom: 4,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.textTertiary,
  },
  placesGroup: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  placesSubhead: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    fontSize: 12,
    color: colors.textMuted,
  },
  item: {
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  itemActive: {
    backgroundColor: colors.cardMutedBg,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemLabel: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  itemLabelMuted: {
    fontSize: 14,
    color: colors.textTertiary,
  },
  itemCity: {
    fontSize: 12,
    color: colors.textMuted,
  },
  theatreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  selectableTheatre: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  theatreRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  theatreTextWrap: {
    flex: 1,
    gap: 2,
  },
  distanceLabel: {
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 0,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pinSlot: {
    borderWidth: 0,
    backgroundColor: "transparent",
  },
  pinGlyph: {
    fontSize: 14,
    lineHeight: 18,
  },
  deadEndRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  forwardAction: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    flexShrink: 0,
  },
  forwardActionText: {
    fontSize: 12,
    color: colors.brandDark,
  },
});
