import { useSeatfirstStore } from "@/store";

import { useSubmitSearchViewModel } from "@/hooks/viewModels/useSubmitSearchViewModel";
import { useSearchSubscription } from "@/hooks/useSearchSubscription";
import { useWhereFieldViewModel } from "@/hooks/viewModels/useWhereFieldViewModel";
import { useWhenFieldViewModel } from "@/hooks/viewModels/useWhenFieldViewModel";
import { useWhenCustomSheetViewModel } from "@/hooks/viewModels/useWhenCustomSheetViewModel";
import { useSearchProgressViewModel } from "@/hooks/viewModels/useSearchProgressViewModel";
import { useSearchResultsViewModel } from "@/hooks/viewModels/useSearchResultsViewModel";
import { useHandoffViewModel } from "@/hooks/viewModels/useHandoffViewModel";

export function useSeatfirstDemo() {
  const store = useSeatfirstStore();

  const { startSearch } = useSearchSubscription();
  const form = useSubmitSearchViewModel({ startSearch });
  const where = useWhereFieldViewModel();
  const when = useWhenFieldViewModel();
  const whenCustom = useWhenCustomSheetViewModel();
  const progress = useSearchProgressViewModel();
  const results = useSearchResultsViewModel();
  const handoff = useHandoffViewModel();

  return {
    ...form,
    ...where,
    ...when,
    ...whenCustom,
    ...progress,
    ...results,
    ...handoff,
    theaterIsSearching: where.isSearching,
    theaterSearchError: where.effectiveTheatreSearchError,
    screen: store.screen,
    actions: {
      ...form.actions,
      ...where.actions,
      ...when.actions,
      ...whenCustom.actions,
      ...progress.actions,
      ...results.actions,
      ...handoff.actions,
      onTheaterChange: where.actions.handleChangeText,
      onTheaterFocus: where.actions.handleFocus,
      onTheaterBlur: where.actions.handleBlur,
      clearTheaterSelection: () => {
        useSeatfirstStore.getState().clearWhere();
        useSeatfirstStore.setState({ whereFocused: true });
      },
    },
  };
}
export type SeatfirstViewModel = ReturnType<typeof useSeatfirstDemo>;
