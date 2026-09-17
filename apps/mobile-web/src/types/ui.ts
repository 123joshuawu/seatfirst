export interface ChipItem {
  label: string;
  active: boolean;
  onPress: () => void;
}

export interface LabeledAction {
  label: string;
  onPress: () => void;
}
