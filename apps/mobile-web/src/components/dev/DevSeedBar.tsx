/**
 * Dev-only picker for the two seeding dials: a store scenario and a mock API profile.
 * Renders nothing outside `__DEV__`.
 *
 * Loaded via dynamic `import()` from `app/_layout.tsx` so it and the fixture data it
 * pulls in stay out of the initial bundle.
 */
import { useState, type ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText } from "@/components/core/AppText";
import {
  applyApiProfile,
  applyDevSeed,
  isDevSeedEnabled,
  readApiProfileId,
  readSeedId,
  writeDevParamsToUrl,
} from "@/fixtures/devSeed";
import { API_PROFILES } from "@/fixtures/mockTransport";
import { DEV_SCENARIOS } from "@/fixtures/scenarios";
import { colors } from "@/theme/colors";

function Row({
  title,
  items,
  activeId,
  onSelect,
}: {
  title: string;
  items: readonly { id: string; label: string }[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
}): ReactElement {
  return (
    <View style={styles.rowWrap}>
      <AppText weight="600" style={styles.rowTitle}>
        {title}
      </AppText>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll}>
        <View style={styles.row}>
          <Pressable
            onPress={() => onSelect(null)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${title}`}
            style={[styles.chip, activeId === null ? styles.chipActive : null]}
          >
            <AppText
              weight="600"
              style={[styles.chipText, activeId === null ? styles.chipTextActive : null]}
            >
              off
            </AppText>
          </Pressable>
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <Pressable
                key={item.id}
                onPress={() => onSelect(item.id)}
                accessibilityRole="button"
                accessibilityLabel={`Seed ${item.label}`}
                style={[styles.chip, isActive ? styles.chipActive : null]}
              >
                <AppText
                  weight="600"
                  style={[styles.chipText, isActive ? styles.chipTextActive : null]}
                >
                  {item.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The profile actually in force at load: an explicit `?api=` if given, otherwise whatever
 * the seeded scenario installed on its own behalf.
 */
function initialApiId(): string | null {
  const explicit = readApiProfileId();
  if (explicit !== null) return explicit;
  const seedId = readSeedId();
  if (seedId === null) return null;
  return DEV_SCENARIOS.find((scenario) => scenario.id === seedId)?.api ?? null;
}

export function DevSeedBar(): ReactElement | null {
  const [activeSeed, setActiveSeed] = useState<string | null>(() => readSeedId());
  const [activeApi, setActiveApi] = useState<string | null>(initialApiId);
  // Starts collapsed when nothing was requested, so the bar never gets in the way of
  // ordinary dev work against a live backend.
  const [collapsed, setCollapsed] = useState(
    () => readSeedId() === null && initialApiId() === null,
  );

  if (!isDevSeedEnabled()) return null;

  const selectScenario = (id: string | null): void => {
    if (id === null) {
      setActiveSeed(null);
      writeDevParamsToUrl({ seed: null });
      return;
    }
    void applyDevSeed(id).then((applied) => {
      if (!applied) return;
      const scenario = DEV_SCENARIOS.find((entry) => entry.id === id);
      const nextApi = scenario?.api ?? null;
      setActiveSeed(id);
      // A scenario that declares a profile installs it, so reflect that in both the
      // chips and the URL rather than leaving the API row showing a stale value.
      if (nextApi !== null) setActiveApi(nextApi);
      writeDevParamsToUrl({ seed: id, ...(nextApi !== null ? { api: nextApi } : {}) });
    });
  };

  const selectApi = (id: string | null): void => {
    void applyApiProfile(id).then((applied) => {
      if (!applied) return;
      setActiveApi(id);
      writeDevParamsToUrl({ api: id });
    });
  };

  return (
    <View style={styles.bar}>
      <Pressable
        onPress={() => setCollapsed((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? "Expand dev scenarios" : "Collapse dev scenarios"}
        style={styles.toggle}
      >
        <AppText weight="600" style={styles.toggleText}>
          {collapsed ? `seed ▲ ${activeSeed ?? "off"} · api ${activeApi ?? "off"}` : "seed ▼"}
        </AppText>
      </Pressable>

      {collapsed ? null : (
        <View style={styles.rows}>
          <Row
            title="screen"
            items={DEV_SCENARIOS.map((scenario) => ({ id: scenario.id, label: scenario.label }))}
            activeId={activeSeed}
            onSelect={selectScenario}
          />
          <Row
            title="api"
            items={API_PROFILES.map((profile) => ({ id: profile.name, label: profile.label }))}
            activeId={activeApi}
            onSelect={selectApi}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "rgba(28,26,23,.92)",
  },
  toggle: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,.14)",
  },
  toggleText: { color: "#fff", fontSize: 11 },
  rows: { flex: 1, gap: 4 },
  rowWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { color: colors.textTertiary, fontSize: 10, width: 44 },
  scroll: { flexGrow: 0 },
  row: { flexDirection: "row", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,.10)",
  },
  chipActive: { backgroundColor: colors.brand },
  chipText: { color: "#e8e4dc", fontSize: 11 },
  chipTextActive: { color: "#fff" },
});
