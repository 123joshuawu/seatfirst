import type { ReactElement } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { colors } from "@/theme/colors";
import type { LabeledAction } from "@/types/ui";
import { AppText } from "@/components/core/AppText";
import { AutocompletePopover } from "@/components/core/Autocomplete";

export interface PopoverListItem extends LabeledAction {
  selected?: boolean;
  disabled?: boolean;
  distanceLabel?: string | null;
  city?: string | null;
}

export interface PopoverListProps {
  header: string;
  items: PopoverListItem[] | LabeledAction[];
  isLocked?: boolean;
  /**
   * ARIA variant — "listbox" for Where/Theatre picker (combobox/listbox),
   * "menu" for legacy callers. Defaults to "listbox" for the a11y migration
   * (ADR 0044 decision 2 dedicated pass).
   */
  variant?: "listbox" | "menu";
  /** Optional listbox id for aria-controls association */
  listboxId?: string;
  /**
   * Mobile override — forwards to `AutocompletePopover`. When true the list
   * renders as a bottom-sheet modal; defaults to the shared viewport check.
   */
  isMobile?: boolean | undefined;
  /** Dismiss handler for the mobile sheet scrim and Close button. */
  onClose?: (() => void) | undefined;
}
export function PopoverList({
  header,
  items,
  isLocked = false,
  variant = "listbox",
  listboxId,
  isMobile,
  onClose,
}: PopoverListProps): ReactElement {
  const isListbox = variant === "listbox";
  const containerRole = isListbox ? "listbox" : "menu";
  const itemRole = isListbox ? "option" : "menuitem";
  return (
    <AutocompletePopover
      id={listboxId ?? "autocomplete-listbox"}
      header={header}
      role={containerRole}
      isMobile={isMobile}
      onClose={onClose}
    >
      {items.map((item, i) => {
        const extended = item as PopoverListItem;
        const disabled = isLocked || !!extended.disabled;
        const selected = !!extended.selected;
        const distanceLabel = extended.distanceLabel ?? null;
        const city = extended.city ?? null;
        return (
          <Pressable
            key={i}
            onPress={disabled ? undefined : item.onPress}
            disabled={disabled}
            accessibilityLabel={item.label}
            accessibilityState={isListbox ? { selected, disabled } : { disabled }}
            accessibilityHint={disabled ? undefined : `Selects ${item.label}`}
            focusable={!disabled}
            {...(Platform.OS === "web"
              ? ({
                  role: itemRole,
                  "aria-selected": isListbox ? (selected ? "true" : "false") : undefined,
                  "aria-disabled": disabled ? "true" : undefined,
                } as unknown as Record<string, unknown>)
              : {})}
            style={[styles.item, disabled && styles.itemDisabled, selected && styles.itemSelected]}
          >
            <View style={styles.itemRow}>
              {isListbox && (
                <View
                  style={[styles.checkbox, selected ? styles.checkboxOn : styles.checkboxOff]}
                  accessible={false}
                  importantForAccessibility="no"
                >
                  {selected ? (
                    <AppText weight="700" style={styles.checkboxGlyph}>
                      ✓
                    </AppText>
                  ) : null}
                </View>
              )}
              <View style={styles.itemTextWrap}>
                <AppText style={styles.itemLabel}>{item.label}</AppText>
                {city ? (
                  <AppText weight="400" style={styles.itemCity}>
                    {city}
                  </AppText>
                ) : null}
              </View>
              {distanceLabel ? (
                <AppText weight="400" style={styles.distanceLabel}>
                  {distanceLabel}
                </AppText>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </AutocompletePopover>
  );
}

const styles = StyleSheet.create({
  item: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemSelected: {
    backgroundColor: colors.cardMutedBg,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  itemTextWrap: {
    flex: 1,
    gap: 2,
  },
  itemLabel: {
    fontSize: 14,
    color: colors.textPrimary,
  },
  itemCity: {
    fontSize: 12,
    color: colors.textMuted,
  },
  distanceLabel: {
    fontSize: 12,
    color: colors.textMuted,
    flexShrink: 0,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: colors.brandDark,
    borderColor: colors.brandDark,
  },
  checkboxOff: {
    backgroundColor: colors.cardBg,
    borderColor: colors.checkboxOffBorder,
  },
  checkboxGlyph: {
    fontSize: 10,
    color: colors.white,
    lineHeight: 10,
  },
});
