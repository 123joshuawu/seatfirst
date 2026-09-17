// Global type augmentations for react-native-web-specific styling.
import "react-native";

declare module "react-native" {
  interface ViewStyle {
    position?: "absolute" | "relative" | "sticky" | "fixed";
    backgroundImage?: string;
  }
}
