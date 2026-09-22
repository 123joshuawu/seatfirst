import { useEffect, useState } from "react";
import type { RecoveryOption } from "@seatfirst/core";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { colors } from "@/theme/colors";
import { LeftPanel } from "@/components/search/LeftPanel";
import { Wordmark } from "@/components/search/Wordmark";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { SearchForm } from "@/components/search/SearchForm";
import { CollapsedFormBar } from "@/components/search/CollapsedFormBar";
import { ReplacementCard } from "@/components/flow/ReplacementCard";
import { ResultScreen } from "@/components/result/ResultScreen";
import { useSearchSubscription } from "@/hooks/useSearchSubscription";

const MOBILE_BREAKPOINT = 680;
// QA audit: the two-column desktop row needs at least 560 (results left-column
// minWidth) + 32 (column gap) + 400 (right-column minWidth) = 992px of content
// width, plus the 24px page gutter on each side = 1040px of viewport width. The
// non-results narrow variant (420 + 32 + 400 = 852 nominal) fits inside that same
// budget. Below 1040px the desktop row overflows and clips right-edge controls
// (repro: 768px iPad portrait), so collapse to the stacked single-column layout.
const TWO_COLUMN_BREAKPOINT = 1040;
export default function SeatfirstScreen() {
  const { width } = useWindowDimensions();
  const isMobile = width < MOBILE_BREAKPOINT;
  const isStackedLayout = width < TWO_COLUMN_BREAKPOINT;

  const screen = useSeatfirstStore((s) => s.screen);
  const storedCollapsed = useSeatfirstStore((s) => s.isFormCollapsed);
  const isFormCollapsed = isStackedLayout ? storedCollapsed : false;
  const recovery = useSeatfirstStore((s) => {
    const result = s.recheckResult;
    return result !== null && result.status === "GONE" ? result.recovery : null;
  });
  const [focusedRecoveryOption, setFocusedRecoveryOption] = useState<RecoveryOption | null>(null);
  useEffect(() => {
    setFocusedRecoveryOption(recovery?.[0] ?? null);
  }, [recovery]);
  const activeRecoveryOption =
    focusedRecoveryOption === null
      ? (recovery?.[0] ?? null)
      : (recovery?.find(
          (option) =>
            option.level === focusedRecoveryOption.level &&
            option.placement.placementKey === focusedRecoveryOption.placement.placementKey &&
            option.showtimeId === focusedRecoveryOption.showtimeId,
        ) ??
        recovery?.[0] ??
        null);
  const showSearchForm = screen === "search" || screen === "checking";
  const { startSearch } = useSearchSubscription();

  const showResults =
    screen === "checking" || screen === "result" || screen === "partial" || screen === "halted";
  const showActionCard = screen === "replacement";

  return (
    <ScrollView
      // QA audit: landmark for the app's primary content region. In this
      // react-native-web version `role="main"` on a View/ScrollView emits a true
      // `<main>` element (see propsToAccessibilityComponent), not a div with an
      // ARIA attribute. This screen is a single-purpose search form with no site
      // header/nav/footer chrome, so `main` is the only landmark to add.
      role="main"
      style={{ flex: 1, backgroundColor: colors.pageBg }}
      contentContainerStyle={[
        styles.pageWrap,
        { padding: isMobile ? 20 : 48, paddingHorizontal: isMobile ? 16 : 24 },
      ]}
    >
      {isStackedLayout ? (
        showResults ? (
          <View style={{ width: "100%" as const, maxWidth: 920, gap: 16 }}>
            {/* QA mobile branding: the stacked results branch never mounts
                LeftPanel, so render the standalone wordmark on mobile
                viewports (purely additive — wider viewports untouched). */}
            {isMobile ? <Wordmark /> : null}
            {isFormCollapsed ? <CollapsedFormBar /> : null}
            <ResultScreen startSearch={startSearch} />
          </View>
        ) : (
          <View style={styles.notResultRowMobile}>
            {/* QA mobile branding: on mobile viewports LeftPanel hides itself
                (showLeftCol) behind the search form, so render the standalone
                wordmark above it. Desktop/tablet render LeftPanel's own. */}
            {isMobile ? <Wordmark /> : null}
            <LeftPanel
              focusedRecoveryOption={activeRecoveryOption}
              isReplacement={screen === "replacement"}
            />

            <View style={styles.rightColumn}>
              {isFormCollapsed ? (
                <CollapsedFormBar />
              ) : showSearchForm ? (
                <SearchForm startSearch={startSearch} />
              ) : null}
              {screen === "replacement" ? (
                <ReplacementCard recovery={recovery} onFocusOption={setFocusedRecoveryOption} />
              ) : null}
            </View>
          </View>
        )
      ) : (
        // ADR 0058 amendment (2026-09-04): the right column is always the search form for the
        // whole search flow (never results); the left column is one evolving output container
        // that now also carries the full results feed (LeftPanel unchanged + ResultScreen
        // mounted alongside it) instead of collapsing to a single centered column.
        // The wide/flex:1 left-column proportion from the amendment is scoped to states where
        // that column actually carries the results feed; ghost/confirmation/auditorium states
        // keep the column snug to its ~340px card so the two columns don't drift apart with a
        // dead gap between them.
        <View style={[styles.desktopRow, showResults ? null : styles.desktopRowNarrow]}>
          <View
            style={[styles.desktopLeftColumn, showResults ? null : styles.desktopLeftColumnNarrow]}
          >
            <View style={styles.desktopLeftPanelSlot}>
              <LeftPanel
                focusedRecoveryOption={activeRecoveryOption}
                isReplacement={screen === "replacement"}
                hidePreviewCard={showResults}
              />
            </View>
            {showResults ? <ResultScreen startSearch={startSearch} showEditAction={false} /> : null}
          </View>

          <View
            style={[
              styles.desktopRightColumn,
              showResults ? styles.desktopRightColumnResults : null,
            ]}
          >
            {!showActionCard ? <SearchForm startSearch={startSearch} /> : null}
            {screen === "replacement" ? (
              <ReplacementCard recovery={recovery} onFocusOption={setFocusedRecoveryOption} />
            ) : null}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = {
  pageWrap: {
    alignItems: "center" as const,
    minHeight: "100%" as const,
  },
  desktopRow: {
    flexDirection: "row" as const,
    width: "100%" as const,
    maxWidth: 1120,
    gap: 32,
    alignItems: "flex-start" as const,
  },
  // The results feed (checking/result/partial/halted) needs the wide flex:1 share above; the
  // ghost/confirmation/auditorium-only states (search, recheck, replacement, confirmed) instead
  // carry a single ~420px card matching LeftPanel's own rootDesktop maxWidth, so the row is
  // overridden to hug that content instead of stretching the column past it.
  desktopRowNarrow: {
    maxWidth: 980,
  },
  desktopLeftColumn: {
    flex: 1,
    minWidth: 560,
    gap: 16,
  },
  desktopLeftColumnNarrow: {
    flex: 0,
    width: 420,
    minWidth: 280,
  },
  // LeftPanel's own root style sets flexBasis/flexGrow/flexShrink meant to size its WIDTH
  // when it sits beside a row sibling (its original layout). Wrapping it in a row-flex slot
  // here keeps that sizing on the width axis instead of it being reinterpreted as a height
  // constraint by the column-flex desktopLeftColumn above.
  desktopLeftPanelSlot: {
    flexDirection: "row" as const,
  },
  desktopRightColumn: {
    flexBasis: 460,
    minWidth: 400,
    maxWidth: 520,
    gap: 16,
    position: "sticky" as const,
    top: 48,
  },
  // ADR 0058 amendment (2026-09-05): during results, the right column recedes to a fixed,
  // narrower width so the left column's results feed reads as the dominant canvas.
  desktopRightColumnResults: {
    flexBasis: 360,
    width: 360,
    minWidth: 360,
    maxWidth: 360,
  },
  notResultRowMobile: {
    flexDirection: "column" as const,
    width: "100%" as const,
    maxWidth: 920,
    gap: 20,
  },
  rightColumn: {
    flex: 1,
    minWidth: 320,
    gap: 16,
  },
};
