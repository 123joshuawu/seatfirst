import type { ReactElement } from "react";
import { Text, type TextProps } from "react-native";
import {
  BODY_FAMILY_BY_WEIGHT,
  DISPLAY_FAMILY_BY_WEIGHT,
  type FontFamilyGroup,
  type FontWeightValue,
} from "@/theme/typography";

export interface AppTextProps extends TextProps {
  /** 'body' = IBM Plex Sans, 'display' = Archivo. Defaults to 'body'. */
  family?: FontFamilyGroup;
  /** Numeric weight as it appears in the mockup's inline styles. Defaults to '400'. */
  weight?: FontWeightValue;
}

export function AppText({
  family = "body",
  weight = "400",
  style,
  ...rest
}: AppTextProps): ReactElement {
  const fontFamilyMap = family === "display" ? DISPLAY_FAMILY_BY_WEIGHT : BODY_FAMILY_BY_WEIGHT;
  return (
    <Text style={[{ fontFamily: fontFamilyMap[weight], fontWeight: weight }, style]} {...rest} />
  );
}
