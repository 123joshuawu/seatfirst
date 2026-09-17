import type { ReactElement, ReactNode } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";
import { useFadeInStyle } from "@/theme/animations";

export interface FadeInViewProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** `animation: sf-fade .3s ease` on mount — used for the result screen and each handoff card. */
export function FadeInView({ children, style }: FadeInViewProps): ReactElement {
  const fadeStyle = useFadeInStyle(300);
  return <Animated.View style={[style, fadeStyle]}>{children}</Animated.View>;
}
