import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import type { TextInput } from "react-native";
import { DEFAULT_SEARCH_LIMITS, type TheatreSearchHit } from "@seatfirst/core";
import { useSeatfirstStore, type SeatfirstStore } from "@/store/seatfirstStore";
import {
  getWhereFieldMode,
  hasWhereSelection,
  type WhereTheatreRef,
} from "@/store/searchFormSlice";
import { useTheatreSearch } from "../useTheatreSearch";
import {
  createGeocodeResolver,
  createSuggestPlaceResolver,
  type GeocodeResolver,
  type SuggestCandidate,
  type SuggestPlaceResolver,
} from "@/lib/geocodeSeam";
import { formatUsPlaceLabel } from "@/lib/placeLabel";

const MILES_TO_KM = 1.609344;
export const RADIUS_OPTIONS: ReadonlyArray<{ label: string; valueKm: number }> = [
  { label: "5 mi", valueKm: 5 * MILES_TO_KM },
  { label: "10 mi", valueKm: 10 * MILES_TO_KM },
  { label: "15 mi", valueKm: 15 * MILES_TO_KM },
  { label: "25 mi", valueKm: DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm },
] as const;

/**
 * A row in the Where UI is either an ambient name-search result
 * (`TheatreSearchHit`, browse/typed-query case) or a resolved place-radius
 * theatre (`WhereTheatreRef`, place-panel case). ADR 0045 SS2a means the
 * client never learns a typed place's coordinates, so the latter cannot reuse
 * the ambient search. Both shapes carry the same presentation fields loosely,
 * so the accessors below read them structurally.
 */
export type WhereListItem = TheatreSearchHit | WhereTheatreRef;

export function formatDistance(distanceKm: number | null | undefined): string | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) return null;
  const mi = distanceKm * 0.621371;
  return `${mi.toFixed(1)} mi`;
}

export function clampRadius(radiusKm: number): number {
  return Math.min(radiusKm, DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
}

export function formatRadius(radiusKm: number): string {
  const option = RADIUS_OPTIONS.find((candidate) => candidate.valueKm === radiusKm);
  return option?.label ?? `${Math.round(radiusKm / MILES_TO_KM)} mi`;
}

/** Screen-reader version of `formatRadius` with the unit spoken in full. */
export function formatRadiusSpoken(radiusKm: number): string {
  const miles = Math.round(radiusKm / MILES_TO_KM);
  return `${miles} ${miles === 1 ? "mile" : "miles"}`;
}

export type WhereOptionKey = `theatre:${string}` | `place:${number}`;

export function getTheatreOptionKey(hit: WhereListItem): WhereOptionKey {
  return `theatre:${getHitId(hit)}`;
}

export function getPlaceOptionKey(index: number): WhereOptionKey {
  return `place:${index}`;
}

export function getWhereOptionId(key: WhereOptionKey): string {
  return key.startsWith("theatre:")
    ? `where-option-theatre-${key.slice("theatre:".length)}`
    : `where-option-place-${key.slice("place:".length)}`;
}

export function getHitId(hit: WhereListItem): string {
  return hit.id;
}

export function getHitName(hit: WhereListItem): string {
  return hit.name ?? hit.id;
}

export function getHitCity(hit: WhereListItem): string | null {
  return hit.city ?? null;
}

export function getHitDistance(hit: WhereListItem): number | null {
  return typeof hit.distanceKm === "number" ? hit.distanceKm : null;
}

export interface WhereFieldViewModel {
  whereFieldMode: "empty" | "place" | "theatres";
  inputValue: string;
  isSearching: boolean;
  isSuggesting: boolean;
  suggestCandidates: SuggestCandidate[];
  showPlaceSignpost: boolean;
  effectiveTheatreSearchError: string | null;
  showPlaceChip: boolean;
  showDeviceChip: boolean;
  showTheatreChips: boolean;
  placeChipLabel: string;
  deviceChipLabel: string;
  geolocationError: string | null;
  geolocationBusy: boolean;
  placeError: string | null;
  placeErrorKind: "PLACE_NOT_FOUND" | "PLACE_RESOLUTION_UNAVAILABLE" | null;
  isResolvingPlace: boolean;
  activeDescendantId: string | null;
  activeIndex: number;
  activeKey: WhereOptionKey | null;
  theatres: TheatreSearchHit[];
  /** True when the typed query substring-matches a theatre name: theatres sort before places. */
  theatresFirst: boolean;
  shouldShowLegacyConfirmed: boolean;
  showDropdown: boolean;
  inputAriaProps: Record<string, unknown>;
  wherePlace: SeatfirstStore["wherePlace"];
  deviceCenter: SeatfirstStore["deviceCenter"];
  selectedTheatres: SeatfirstStore["selectedTheatres"];
  whereRadiusKm: number;
  actions: {
    handleChangeText: (text: string) => void;
    handleFocus: () => void;
    handleBlur: () => void;
    handleSelectTheatre: (hit: WhereListItem) => void;
    handleSelectCandidate: (candidate: SuggestCandidate) => void;
    handleClearWhere: () => void;
    handleConvertWherePlaceToTheatres: () => void;
    handleFollowPlaceSignpost: () => void;
    handleRemovePlaceChip: () => void;
    handleRemoveTheatreChip: (id: string) => void;
    handleBackspaceRemoveLast: () => void;
    handleUseLocation: () => void;
    handleResolvePlace: () => Promise<void>;
    handleKeyDown: (e: unknown, inputRef: React.RefObject<TextInput | null>) => void;
    setWhereRadiusKm: (radiusKm: number) => void;
  };
}

export interface UseWhereFieldViewModelProps {
  theaterConfirmed?: boolean;
  theaterValue?: string;
  theaterFocused?: boolean;
  theaterSearchError?: string | null;
  onChangeText?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  isLocked?: boolean;
  /** Test seam; production defaults to the tRPC-backed resolver. */
  geocodeResolver?: GeocodeResolver;
  /** Test seam; production defaults to the tRPC-backed resolver. */
  suggestPlaceResolver?: SuggestPlaceResolver;
}

export function useWhereFieldViewModel({
  theaterConfirmed = false,
  theaterValue,
  theaterFocused,
  theaterSearchError = null,
  onChangeText,
  onFocus,
  onBlur,
  isLocked = false,
  geocodeResolver,
  suggestPlaceResolver,
}: UseWhereFieldViewModelProps = {}): WhereFieldViewModel {
  const storeWhereQuery = useSeatfirstStore((s) => s.whereQuery);
  const storeWhereFocused = useSeatfirstStore((s) => s.whereFocused);
  const deviceCenter = useSeatfirstStore((s) => s.deviceCenter);
  const wherePlace = useSeatfirstStore((s) => s.wherePlace);
  const selectedTheatres = useSeatfirstStore((s) => s.selectedTheatres);
  const whereFieldMode = useSeatfirstStore((s) => getWhereFieldMode(s));
  const whereRadiusKm = useSeatfirstStore((s) => s.whereRadiusKm);
  const hasSelection = useSeatfirstStore((s) => hasWhereSelection(s));
  const setWhereQuery = useSeatfirstStore((s) => s.setWhereQuery);
  const setWhereFocused = useSeatfirstStore((s) => s.setWhereFocused);
  const onWhereFocusStore = useSeatfirstStore((s) => s.onWhereFocus);
  const onWhereBlurStore = useSeatfirstStore((s) => s.onWhereBlur);
  const selectDeviceLocation = useSeatfirstStore((s) => s.selectDeviceLocation);
  const selectPlaceStore = useSeatfirstStore((s) => s.selectPlace);
  const setSelectedTheatres = useSeatfirstStore((s) => s.setSelectedTheatres);
  const toggleTheatre = useSeatfirstStore((s) => s.toggleTheatre);
  const deselectTheatre = useSeatfirstStore((s) => s.deselectTheatre);
  const removeLastChip = useSeatfirstStore((s) => s.removeLastChip);
  const clearWhere = useSeatfirstStore((s) => s.clearWhere);
  const convertWherePlaceToTheatres = useSeatfirstStore((s) => s.convertWherePlaceToTheatres);
  const setWhereRadiusKm = useSeatfirstStore((s) => s.setWhereRadiusKm);
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);
  const storePlaceError = useSeatfirstStore((s) => s.wherePlaceError);
  const storePlaceErrorKind = useSeatfirstStore((s) => s.wherePlaceErrorKind);

  const effectiveWhereQuery = storeWhereQuery ?? theaterValue ?? "";
  const effectiveWhereFocused = storeWhereFocused ?? theaterFocused ?? false;

  const [geolocationError, setGeolocationError] = useState<string | null>(null);
  const [geolocationBusy, setGeolocationBusy] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [placeErrorKind, setPlaceErrorKind] = useState<
    "PLACE_NOT_FOUND" | "PLACE_RESOLUTION_UNAVAILABLE" | null
  >(null);
  const effectivePlaceError = placeError ?? storePlaceError;
  const effectivePlaceErrorKind = placeErrorKind ?? storePlaceErrorKind;

  const clearPlaceError = useCallback(() => {
    setPlaceError(null);
    setPlaceErrorKind(null);
    if (useSeatfirstStore.getState().wherePlaceError) {
      useSeatfirstStore.setState({ wherePlaceError: null, wherePlaceErrorKind: null });
    }
  }, []);
  const [isResolvingPlace, setIsResolvingPlace] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestCandidates, setSuggestCandidates] = useState<SuggestCandidate[]>([]);
  const [activeKey, setActiveKey] = useState<WhereOptionKey | null>(null);
  const suppressSuggestQueryRef = useRef<string | null>(null);

  const placeResolver = useMemo(
    () => geocodeResolver ?? createGeocodeResolver({ providerId: "amc" }),
    [geocodeResolver],
  );
  const suggestionResolver = useMemo(
    () => suggestPlaceResolver ?? createSuggestPlaceResolver({ providerId: "amc" }),
    [suggestPlaceResolver],
  );

  const inputValue = effectiveWhereQuery;

  const theatreQuery = whereFieldMode === "place" ? "" : inputValue;
  // `whereFieldMode === "place"` covers both a typed `wherePlace` (which never stores a
  // coordinate — ADR 0045 — and resolves its own theatre list at selection time, so this
  // hook must stay disabled for it) and `deviceCenter` (which DOES carry real lat/lng and
  // has no other resolver — it depends entirely on this hook's radius-filtered browse to
  // ever populate theatres). Only the typed-place case should suppress `browse`.
  const browse =
    effectiveWhereFocused &&
    inputValue.trim().length === 0 &&
    (whereFieldMode !== "place" || deviceCenter !== null);
  const theatreSearch = useTheatreSearch({
    q: theatreQuery,
    lat: deviceCenter?.lat,
    lng: deviceCenter?.lng,
    radiusKm: deviceCenter ? clampRadius(whereRadiusKm) : undefined,
    limit: DEFAULT_SEARCH_LIMITS.maxTheatres,
    browse,
  } as never);

  const theatres: TheatreSearchHit[] = useMemo(() => {
    const data = (theatreSearch.data as { theatres?: TheatreSearchHit[] } | undefined)?.theatres;
    return data && Array.isArray(data) ? data : [];
  }, [theatreSearch.data]);
  const isSearching = Boolean((theatreSearch as { isFetching?: boolean }).isFetching);
  const effectiveTheatreSearchError = (() => {
    if (theaterSearchError) return theaterSearchError;
    const error = (theatreSearch as { error?: unknown }).error;
    if (!error) return null;
    return error instanceof Error ? error.message : "Unable to load theatres";
  })();
  const isTheatreSignpostProbe =
    whereFieldMode === "theatres" &&
    !isSearching &&
    effectiveTheatreSearchError === null &&
    theatres.length === 0;
  const shouldSuggestPlaces = whereFieldMode !== "theatres" || isTheatreSignpostProbe;

  useEffect(() => {
    const query = inputValue.trim();

    // Candidate presses write their label immediately before resolvePlace. Do
    // not spend suggestion budget re-suggesting that programmatic value.
    if (suppressSuggestQueryRef.current === query) {
      suppressSuggestQueryRef.current = null;
      setSuggestCandidates([]);
      setIsSuggesting(false);
      return;
    }

    if (isLocked || !effectiveWhereFocused || query.length < 3 || !shouldSuggestPlaces) {
      setSuggestCandidates([]);
      setIsSuggesting(false);
      return;
    }

    setIsSuggesting(true);
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (cancelled) return;
      void suggestionResolver
        .suggestPlace(query)
        .then((result) => {
          if (!cancelled) {
            setSuggestCandidates("candidates" in result ? result.candidates : []);
          }
        })
        .catch(() => {
          // Suggestion failures remain silent; verbatim place resolution is
          // still available through Enter.
          if (!cancelled) setSuggestCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setIsSuggesting(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [effectiveWhereFocused, inputValue, isLocked, shouldSuggestPlaces, suggestionResolver]);

  const navigableTheatres = useMemo<WhereListItem[]>(
    () => (whereFieldMode === "place" ? [] : theatres),
    [theatres, whereFieldMode],
  );
  const navigablePlaceCandidates = whereFieldMode === "theatres" ? [] : suggestCandidates;
  const showPlaceSignpost =
    whereFieldMode === "theatres" &&
    effectiveTheatreSearchError === null &&
    inputValue.trim().length > 0 &&
    theatres.length === 0 &&
    suggestCandidates.length > 0;
  // Client-side relevance: when the typed query substring-matches any visible
  // theatre name, surface theatres ahead of generic place/address candidates.
  // Theatre-vs-theatre relative order (server radius/distance) is preserved;
  // only the group boundary moves. No new data required.
  const theatresFirst = useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    if (q.length === 0 || navigableTheatres.length === 0) return false;
    return navigableTheatres.some((hit) => getHitName(hit).toLowerCase().includes(q));
  }, [inputValue, navigableTheatres]);
  const optionKeys = useMemo<WhereOptionKey[]>(
    () =>
      theatresFirst
        ? [
            ...navigableTheatres.map((hit) => getTheatreOptionKey(hit)),
            ...navigablePlaceCandidates.map((_, index) => getPlaceOptionKey(index)),
          ]
        : [
            ...navigablePlaceCandidates.map((_, index) => getPlaceOptionKey(index)),
            ...navigableTheatres.map((hit) => getTheatreOptionKey(hit)),
          ],
    [navigablePlaceCandidates, navigableTheatres, theatresFirst],
  );
  const effectiveActiveKey =
    activeKey !== null && (optionKeys as readonly string[]).includes(activeKey) ? activeKey : null;
  const activeIndex = effectiveActiveKey === null ? -1 : optionKeys.indexOf(effectiveActiveKey);
  const activeDescendantId =
    effectiveActiveKey === null ? null : getWhereOptionId(effectiveActiveKey);

  useEffect(() => {
    if (activeKey !== null && !(optionKeys as readonly string[]).includes(activeKey)) {
      setActiveKey(null);
    }
  }, [activeKey, optionKeys]);

  const showPlaceChip = wherePlace !== null;
  const showDeviceChip = deviceCenter !== null && wherePlace === null;
  const showTheatreChips = whereFieldMode === "theatres";

  const placeChipLabel = wherePlace
    ? `${formatUsPlaceLabel(wherePlace.resolvedPlaceName ?? wherePlace.query)} · ${formatRadius(wherePlace.radiusKm)}`
    : "";
  const deviceChipLabel = deviceCenter ? `Current location · ${formatRadius(whereRadiusKm)}` : "";

  const handleChangeText = useCallback(
    (text: string) => {
      if (effectivePlaceError) {
        clearPlaceError();
      }
      if (geolocationError) setGeolocationError(null);
      if (onChangeText) onChangeText(text);
      setWhereQuery(text);
      setActiveKey(null);
    },
    [onChangeText, setWhereQuery, effectivePlaceError, clearPlaceError, geolocationError],
  );

  const handleFocus = useCallback(() => {
    if (isLocked) return;
    if (onFocus) onFocus();
    onWhereFocusStore();
    if (effectivePlaceError) {
      clearPlaceError();
    }
  }, [isLocked, onFocus, onWhereFocusStore, effectivePlaceError, clearPlaceError]);

  const handleBlur = useCallback(() => {
    if (onBlur) onBlur();
    onWhereBlurStore();
    setActiveKey(null);
  }, [onBlur, onWhereBlurStore]);

  const handleSelectTheatre = useCallback(
    (hit: WhereListItem) => {
      if (whereFieldMode === "place") return;
      const id = getHitId(hit);
      const providerId = hit.providerId;
      if (!id) return;
      toggleTheatre({
        id,
        providerId,
        name: getHitName(hit),
        city: getHitCity(hit),
        distanceKm: getHitDistance(hit),
      });
      setWhereQuery("");
      setActiveKey(null);
    },
    [setWhereQuery, toggleTheatre, whereFieldMode],
  );

  const handleClearWhere = useCallback(() => {
    clearWhere();
    setActiveKey(null);
    clearPlaceError();
    setGeolocationError(null);
  }, [clearPlaceError, clearWhere]);

  const handleRemovePlaceChip = handleClearWhere;

  const handleRemoveTheatreChip = useCallback(
    (id: string) => {
      if (whereFieldMode !== "theatres") return;
      deselectTheatre(id);
    },
    [deselectTheatre, whereFieldMode],
  );

  const handleConvertWherePlaceToTheatres = useCallback(() => {
    if (whereFieldMode !== "place") return;
    convertWherePlaceToTheatres();
    setActiveKey(null);
  }, [convertWherePlaceToTheatres, whereFieldMode]);

  const handleFollowPlaceSignpost = useCallback(() => {
    if (whereFieldMode !== "theatres") return;
    const query = inputValue;
    clearWhere();
    setWhereQuery(query);
    setWhereFocused(true);
    setActiveKey(null);
  }, [clearWhere, inputValue, setWhereFocused, setWhereQuery, whereFieldMode]);

  const handleBackspaceRemoveLast = useCallback(() => {
    if (inputValue.length === 0) {
      removeLastChip();
    }
  }, [inputValue, removeLastChip]);

  const handleUseLocation = useCallback(() => {
    if (isLocked) return;
    setGeolocationError(null);
    setPlaceError(null);
    setPlaceErrorKind(null);
    const isSecure =
      typeof window !== "undefined"
        ? (window as unknown as { isSecureContext?: boolean }).isSecureContext
        : undefined;
    if (isSecure === false) {
      setGeolocationError("Location is unavailable in this context. Try typing a place instead.");
      return;
    }
    const geo =
      typeof navigator !== "undefined"
        ? (navigator as unknown as { geolocation?: Geolocation })?.geolocation
        : undefined;
    if (!geo) {
      setGeolocationError(
        "Geolocation is not supported in this browser. Try typing a place instead.",
      );
      return;
    }
    setGeolocationBusy(true);
    geo.getCurrentPosition(
      (pos) => {
        setGeolocationBusy(false);
        const center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        selectDeviceLocation(center);
        setGeolocationError(null);
      },
      (err: GeolocationPositionError) => {
        setGeolocationBusy(false);
        let msg: string;
        switch (err.code) {
          case err.PERMISSION_DENIED:
            msg = "Location permission denied. You can still type a place or pick a theatre.";
            break;
          case err.TIMEOUT:
            msg = "Location request timed out. Try again or type a place.";
            break;
          default:
            msg = "Location is unavailable. Try typing a place instead.";
        }
        setGeolocationError(msg);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }, [isLocked, selectDeviceLocation]);

  const resolvePlaceAtRadius = useCallback(
    async (query: string, radiusKm: number) => {
      const q = query.trim();
      if (q.length === 0 || isLocked) return;
      setIsResolvingPlace(true);
      setPlaceError(null);
      setPlaceErrorKind(null);
      try {
        const clampedRadius = clampRadius(radiusKm);
        const limit = DEFAULT_SEARCH_LIMITS.maxTheatres;
        const result = await placeResolver.resolvePlace(q, clampedRadius, limit);
        const kind = (result as { kind?: string }).kind;
        if (kind === "PLACE_NOT_FOUND") {
          // Keep only the core sentence here: `TheaterField` appends the
          // "Try a different..." hint exactly once for PLACE_NOT_FOUND.
          setPlaceError("We couldn't find that place.");
          setPlaceErrorKind("PLACE_NOT_FOUND");
        } else if (kind === "PLACE_RESOLUTION_UNAVAILABLE") {
          setPlaceError("Place lookup is temporarily unavailable. Please try again.");
          setPlaceErrorKind("PLACE_RESOLUTION_UNAVAILABLE");
        } else {
          const success = result as {
            theatres: {
              theatreId: string;
              distanceKm: number;
              name: string;
              city: string | null;
            }[];
            label: string;
            resolvedPlaceName: string;
          };
          selectPlaceStore({
            query: q,
            label: success.label,
            resolvedPlaceName: success.resolvedPlaceName,
            radiusKm: clampedRadius,
            limit,
          });
          const refs = success.theatres.map((resolved) => {
            // Names come from the resolve response itself: the ambient
            // `theatres` search is disabled in place mode (ADR 0045 §1), so
            // it is empty here and cannot be the name source. Keep it only
            // as a fallback for stale/partial responses.
            const hit = theatres.find((candidate) => getHitId(candidate) === resolved.theatreId);
            const name = resolved.name ?? (hit ? getHitName(hit) : undefined);
            const city = resolved.city ?? (hit ? getHitCity(hit) : undefined);
            return {
              id: resolved.theatreId,
              providerId: "amc",
              ...(name !== undefined ? { name } : {}),
              ...(city !== undefined ? { city } : {}),
              distanceKm: resolved.distanceKm,
            };
          });
          setSelectedTheatres(refs);
          setWhereQuery("");
          setPlaceError(null);
          setPlaceErrorKind(null);
          setGeolocationError(null);
        }
      } catch {
        setPlaceError("Place lookup is temporarily unavailable. Please try again.");
        setPlaceErrorKind("PLACE_RESOLUTION_UNAVAILABLE");
      } finally {
        setIsResolvingPlace(false);
      }
    },
    [isLocked, placeResolver, selectPlaceStore, setSelectedTheatres, setWhereQuery, theatres],
  );

  const handleResolvePlace = useCallback(async () => {
    if (whereFieldMode === "theatres") return;
    await resolvePlaceAtRadius(inputValue, whereRadiusKm);
  }, [inputValue, whereFieldMode, whereRadiusKm, resolvePlaceAtRadius]);

  const handleSelectCandidate = useCallback(
    (candidate: SuggestCandidate) => {
      if (isLocked || whereFieldMode === "theatres") return;
      suppressSuggestQueryRef.current = candidate.label.trim();
      setWhereQuery(candidate.label);
      setSuggestCandidates([]);
      setActiveKey(null);
      void resolvePlaceAtRadius(candidate.label, whereRadiusKm);
    },
    [isLocked, resolvePlaceAtRadius, setWhereQuery, whereFieldMode, whereRadiusKm],
  );

  // Radius chip press: a typed, resolved place must re-query at the new radius (the
  // server never returns the geocoded coordinate to the client — ADR 0045 §1 — so the
  // only way to grow/shrink the theatre set for a place is to re-resolve it). Device
  // location has no such constraint; setWhereRadiusKm alone is enough, and the effect
  // below re-syncs selectedTheatres once the wider/narrower radiusKm changes the query.
  const handleSetRadius = useCallback(
    (radiusKm: number) => {
      if (isLocked) return;
      if (wherePlace) {
        void resolvePlaceAtRadius(wherePlace.query, radiusKm);
        return;
      }
      setWhereRadiusKm(radiusKm);
    },
    [isLocked, wherePlace, resolvePlaceAtRadius, setWhereRadiusKm],
  );

  // Keep the derived device-centred theatre refs in sync with the live
  // in-radius browse query. Theatre rows are never rendered as editable while
  // device location is active, so this effect cannot overwrite a hand-picked
  // selection.
  useEffect(() => {
    if (deviceCenter && theatres.length > 0 && bootstrapReady) {
      const refs = theatres
        .map((t) => ({
          id: getHitId(t),
          providerId: t.providerId,
          name: getHitName(t),
          city: getHitCity(t),
          distanceKm: getHitDistance(t),
        }))
        .filter((r) => r.id);
      if (refs.length > 0) setSelectedTheatres(refs);
    }
  }, [deviceCenter, theatres, bootstrapReady, setSelectedTheatres]);

  const handleKeyDown = useCallback(
    (e: unknown, inputRef: React.RefObject<TextInput | null>) => {
      if (isLocked) return;
      const key =
        (e as { key?: string; nativeEvent?: { key?: string } }).key ??
        (e as { nativeEvent?: { key?: string } }).nativeEvent?.key;
      if (key === "Backspace" && inputValue.length === 0) {
        (e as { preventDefault?: () => void }).preventDefault?.();
        handleBackspaceRemoveLast();
        return;
      }
      if (key === "Enter") {
        if (effectiveActiveKey?.startsWith("theatre:")) {
          const theatreId = effectiveActiveKey.slice("theatre:".length);
          const theatre = navigableTheatres.find((hit) => getHitId(hit) === theatreId);
          if (theatre) {
            (e as { preventDefault?: () => void }).preventDefault?.();
            handleSelectTheatre(theatre);
            return;
          }
        } else if (effectiveActiveKey?.startsWith("place:")) {
          const candidateIndex = Number(effectiveActiveKey.slice("place:".length));
          const candidate = suggestCandidates[candidateIndex];
          if (candidate) {
            (e as { preventDefault?: () => void }).preventDefault?.();
            handleSelectCandidate(candidate);
            return;
          }
        }
        if (inputValue.trim().length > 0) {
          (e as { preventDefault?: () => void }).preventDefault?.();
          void handleResolvePlace();
        }
        return;
      }
      if (key === "ArrowDown") {
        (e as { preventDefault?: () => void }).preventDefault?.();
        if (optionKeys.length === 0) {
          setActiveKey(null);
          return;
        }
        const next = Math.min(activeIndex + 1, optionKeys.length - 1);
        setActiveKey(optionKeys[next] ?? null);
      } else if (key === "ArrowUp") {
        (e as { preventDefault?: () => void }).preventDefault?.();
        if (optionKeys.length === 0) {
          setActiveKey(null);
          return;
        }
        const next = activeIndex <= 0 ? 0 : activeIndex - 1;
        setActiveKey(optionKeys[next] ?? null);
      } else if (key === "Escape") {
        setWhereFocused(false);
        setActiveKey(null);
        inputRef.current?.blur();
      }
    },
    [
      isLocked,
      inputValue,
      effectiveActiveKey,
      activeIndex,
      optionKeys,
      navigableTheatres,
      suggestCandidates,
      handleSelectTheatre,
      handleSelectCandidate,
      handleResolvePlace,
      handleBackspaceRemoveLast,
      setWhereFocused,
    ],
  );

  const showDropdown = effectiveWhereFocused && !isLocked;

  const shouldShowLegacyConfirmed =
    theaterConfirmed &&
    !hasSelection &&
    !wherePlace &&
    !deviceCenter &&
    selectedTheatres.length === 0;
  const dropdownId = whereFieldMode === "place" ? "where-place-panel" : "where-listbox";
  const inputAriaProps =
    Platform.OS === "web"
      ? whereFieldMode === "place"
        ? {
            "aria-label": "Where — place or theatre",
            "aria-controls": dropdownId,
          }
        : {
            role: "combobox" as const,
            "aria-expanded": showDropdown ? "true" : "false",
            "aria-controls": dropdownId,
            "aria-autocomplete": "list" as const,
            "aria-activedescendant": activeDescendantId ?? undefined,
            "aria-label": "Where — place or theatre",
          }
      : {};

  return {
    whereFieldMode,
    inputValue,
    isSearching,
    isSuggesting,
    suggestCandidates,
    showPlaceSignpost,
    effectiveTheatreSearchError,
    showPlaceChip,
    showDeviceChip,
    showTheatreChips,
    placeChipLabel,
    deviceChipLabel,
    geolocationError,
    geolocationBusy,
    placeError: effectivePlaceError,
    placeErrorKind: effectivePlaceErrorKind,
    isResolvingPlace,
    activeDescendantId,
    activeIndex,
    activeKey: effectiveActiveKey,
    theatres,
    theatresFirst,
    shouldShowLegacyConfirmed,
    showDropdown,
    inputAriaProps,
    wherePlace,
    deviceCenter,
    selectedTheatres,
    whereRadiusKm,
    actions: {
      handleChangeText,
      handleFocus,
      handleBlur,
      handleSelectTheatre,
      handleSelectCandidate,
      handleClearWhere,
      handleConvertWherePlaceToTheatres,
      handleFollowPlaceSignpost,
      handleRemovePlaceChip,
      handleRemoveTheatreChip,
      handleBackspaceRemoveLast,
      handleUseLocation,
      handleResolvePlace,
      handleKeyDown,
      setWhereRadiusKm: handleSetRadius,
    },
  };
}
