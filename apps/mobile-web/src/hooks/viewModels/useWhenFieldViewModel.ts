import { useSeatfirstStore } from "@/store/seatfirstStore";
import { getDedupedPresets, resolveWhenReadout } from "@/lib/whenPresets";

export interface WhenFieldViewModel {
  dedupedPresets: string[];
  activePreset: string;
  readout: string;
  actions: {
    handlePresetPress: (label: string) => void;
  };
}

export function useWhenFieldViewModel(): WhenFieldViewModel {
  const whenPreset = useSeatfirstStore((s) => s.whenPreset);
  const isCustom = useSeatfirstStore((s) => s.isCustom);
  const selectedBands = useSeatfirstStore((s) => s.selectedBands);
  const selectedDates = useSeatfirstStore((s) => s.selectedDates);
  const selectWhenPreset = useSeatfirstStore((s) => s.selectWhenPreset);
  const setWhenSheetOpen = useSeatfirstStore((s) => s.setWhenSheetOpen);

  const now = new Date();
  const dedupedPresets = getDedupedPresets(now);
  const activePreset = isCustom ? "Custom" : whenPreset;

  const readout = resolveWhenReadout({ selectedDates, selectedBands });

  const handlePresetPress = (label: string) => {
    if (label === "Custom") {
      setWhenSheetOpen(true);
      selectWhenPreset("Custom");
    } else {
      selectWhenPreset(label);
    }
  };

  return {
    dedupedPresets,
    activePreset,
    readout,
    actions: {
      handlePresetPress,
    },
  };
}
