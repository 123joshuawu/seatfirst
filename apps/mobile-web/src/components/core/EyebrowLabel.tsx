import type { ReactElement, ReactNode } from "react";
import { colors } from "@/theme/colors";
import { AppText } from "./AppText";

export interface EyebrowLabelProps {
  children: ReactNode;
  /** Form field labels use 10.5px/600 with 0.12em tracking; section headers ("Choose a showtime") use 700. */
  weight?: "600" | "700";
  color?: string;
  marginBottom?: number;
}

export function EyebrowLabel({
  children,
  weight = "600",
  color = colors.textTertiary,
  marginBottom = 8,
}: EyebrowLabelProps): ReactElement {
  return (
    <AppText
      weight={weight}
      style={{
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: 1.26,
        color,
        marginBottom,
      }}
    >
      {children}
    </AppText>
  );
}
