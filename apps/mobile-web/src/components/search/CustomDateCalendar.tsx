import type { ReactElement } from "react";
import { View, Pressable } from "react-native";
import { AppText } from "@/components/core/AppText";
import { localDateString } from "@/lib/dates";
import { getFacetDisplay, shouldDimFacet } from "@/lib/facetCounts";
import type { FacetCountEntry } from "@/lib/facetCounts";

export interface CustomDateCalendarProps {
  /** UI22: explicit selected date set (YYYY-MM-DD). When provided, selection is set-membership. */
  selectedDates?: readonly string[];
  /** @deprecated — use selectedDates (range form kept for backward compat with legacy tests) */
  fromIso?: string;
  /** @deprecated — use selectedDates */
  toIso?: string;
  minIso: string; // earliest selectable day (today)
  maxIso: string; // latest selectable day (today + 29 — a 30-day window)
  onSelectDay: (iso: string) => void; // fires once per tap on any enabled day
  /** UI23: DATE-axis facet counts keyed by ISO date. When omitted, cells render with no badge. */
  facetCounts?: Map<string, FacetCountEntry>;
  /** UI23: live selected-theatre count the facet request was scoped to. */
  totalTheatres?: number;
}

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;

const CALENDAR_COLUMNS = 7;
/** Exact 1/7 width so 7 columns sum to 100% — never `7 × 14.28% + gaps`. */
const COLUMN_WIDTH = `${100 / CALENDAR_COLUMNS}%` as const;
/** Visual inter-cell spacing: padding *inside* the fixed 1/7 column. RN measures
 * width border-box, so this inset never pushes a column onto the next row. */
const CELL_INSET = 2;

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export function CustomDateCalendar(props: CustomDateCalendarProps): ReactElement {
  const { selectedDates, fromIso, toIso, minIso, maxIso, onSelectDay, facetCounts, totalTheatres } =
    props;
  // UI22: render selection by set membership; keep deprecated range fallback for legacy callers
  const selectedSet = (() => {
    if (selectedDates !== undefined) return new Set(selectedDates);
    if (fromIso !== undefined && toIso !== undefined) {
      const set = new Set<string>();
      // Legacy fallback: treat inclusive [fromIso, toIso] as selected set for old tests
      const cur = new Date(fromIso + "T00:00:00");
      const end = new Date(toIso + "T00:00:00");
      while (cur <= end) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, "0");
        const d = String(cur.getDate()).padStart(2, "0");
        set.add(`${y}-${m}-${d}`);
        cur.setDate(cur.getDate() + 1);
      }
      return set;
    }
    return new Set<string>();
  })();

  const minDate = new Date(minIso + "T00:00:00");
  const maxDate = new Date(maxIso + "T00:00:00");
  const leadingFillerCount = minDate.getDay();

  // Group days by calendar month so a range crossing a month boundary renders a
  // lightweight month-label header per section instead of silently jumping day numbers.
  // Each section restarts weekday alignment from its own first day, so every month's
  // grid lines up with the shared weekday header above.
  const monthGroups: Array<{
    key: string;
    label: string;
    days: Array<{ iso: string; date: Date }>;
    leadingFillers: number;
  }> = [];
  // Build ordered list of every iso/date in [minIso, maxIso] inclusive.
  const days: Array<{ iso: string; date: Date }> = [];
  for (const d = new Date(minDate); d <= maxDate; d.setDate(d.getDate() + 1)) {
    // Copy before pushing so the stored Date is not mutated on next iteration.
    const copy = new Date(d);
    days.push({ iso: localDateString(copy), date: copy });
  }
  for (const day of days) {
    const key = `${day.date.getFullYear()}-${day.date.getMonth()}`;
    const last = monthGroups[monthGroups.length - 1];
    if (last && last.key === key) {
      last.days.push(day);
    } else {
      monthGroups.push({
        key,
        label: monthFormatter.format(day.date),
        days: [day],
        // First section continues the range's own weekday offset; later sections
        // align from the weekday of the 1st.
        leadingFillers: monthGroups.length === 0 ? leadingFillerCount : day.date.getDay(),
      });
    }
  }

  const renderDayCell = ({ iso, date }: { iso: string; date: Date }): ReactElement => {
    const selected = selectedSet.has(iso);
    // UI23: no facetCounts — render exactly the UI22 cell (regression guard).
    if (!facetCounts) {
      return (
        <View key={iso} style={{ width: COLUMN_WIDTH, padding: CELL_INSET }}>
          <Pressable
            onPress={() => onSelectDay(iso)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={dateFormatter.format(date)}
            style={{
              width: "100%",
              aspectRatio: 1,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
              borderWidth: 1,
              borderColor: selected ? "#111827" : "#D1D5DB",
              backgroundColor: selected ? "#111827" : "#fff",
            }}
          >
            <AppText
              weight={selected ? "700" : "500"}
              style={{
                fontSize: 14,
                color: selected ? "#fff" : "#111827",
              }}
            >
              {String(date.getDate())}
            </AppText>
          </Pressable>
        </View>
      );
    }
    // UI23: calendar compact copy (ADR 0051 §B) — number, `n+`, or no badge.
    // Never "not checked yet" text inside a cell.
    const entry = facetCounts.get(iso);
    const total = totalTheatres ?? 0;
    const display = getFacetDisplay(entry, total);
    const dim = shouldDimFacet(entry, total);
    const badge =
      entry && total > 0 && !display.isNotCheckedYet
        ? display.isPartial
          ? `${entry.count}+`
          : String(entry.count)
        : null;
    return (
      <View key={iso} style={{ width: COLUMN_WIDTH, padding: CELL_INSET }}>
        <Pressable
          onPress={() => onSelectDay(iso)}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={dateFormatter.format(date)}
          style={{
            width: "100%",
            aspectRatio: 1,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 2,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: selected ? "#111827" : "#D1D5DB",
            backgroundColor: selected ? "#111827" : "#fff",
            ...(dim ? { opacity: 0.5 } : {}),
          }}
        >
          <AppText
            weight={selected ? "700" : "500"}
            style={{
              fontSize: 14,
              color: selected ? "#fff" : "#111827",
            }}
          >
            {String(date.getDate())}
          </AppText>
          {badge !== null ? (
            <AppText
              weight="500"
              style={{
                fontSize: 10,
                color: selected ? "#fff" : "#111827",
              }}
            >
              {badge}
            </AppText>
          ) : null}
        </Pressable>
      </View>
    );
  };

  return (
    <View>
      {/* Weekday header — Sunday-first, non-interactive. Sticky within the
          sheet's ScrollView so the S M T W T F S row stays pinned while the
          user scrolls through months (same `position: sticky` convention as
          SearchForm's mobile CTA bar / LeftPanel). Opaque background + zIndex
          so month headings/cells scrolling underneath never bleed through. */}
      <View
        testID="calendar-weekday-header"
        style={{
          flexDirection: "row",
          position: "sticky",
          top: 0,
          zIndex: 1,
          backgroundColor: "#fff",
        }}
      >
        {WEEKDAY_LABELS.map((label, idx) => (
          <View
            key={`dow-${idx}-${label}`}
            style={{
              width: COLUMN_WIDTH,
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 4,
            }}
          >
            <AppText weight="500" style={{ fontSize: 11, color: "#6B7280" }}>
              {label}
            </AppText>
          </View>
        ))}
      </View>

      {/* Calendar grid — one month section per calendar month in the range, so a
          range crossing a month boundary keeps its month context instead of silently
          jumping day numbers. Each section grid uses exact 1/7 columns with no flex
          gap, so header and date cells stay pixel-aligned with 7 cells per row. */}
      {monthGroups.map((group, groupIndex) => (
        <View key={group.key}>
          <AppText
            weight="600"
            accessibilityRole="header"
            style={{
              fontSize: 13,
              color: "#111827",
              paddingTop: groupIndex === 0 ? 4 : 8,
              paddingBottom: 4,
            }}
          >
            {group.label}
          </AppText>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
            }}
          >
            {/* Blank filler cells so the section aligns to real weekdays */}
            {Array.from({ length: group.leadingFillers }).map((_, i) => (
              <View
                key={`${group.key}-filler-${i}`}
                style={{ width: COLUMN_WIDTH, padding: CELL_INSET }}
              >
                <View style={{ aspectRatio: 1 }} />
              </View>
            ))}
            {group.days.map((day) => renderDayCell(day))}
          </View>
        </View>
      ))}
    </View>
  );
}
