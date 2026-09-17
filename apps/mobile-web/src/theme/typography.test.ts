import { describe, expect, it } from "vitest";
import { BODY_FAMILY_BY_WEIGHT, fontFamily } from "./typography";

describe("typography", () => {
  it("maps bold body weights (700, 800) to IBMPlexSans_700Bold per ADR 0068 Decision 3", () => {
    expect(fontFamily.bodyBold).toBe("IBMPlexSans_700Bold");
    expect(BODY_FAMILY_BY_WEIGHT["700"]).toBe("IBMPlexSans_700Bold");
    expect(BODY_FAMILY_BY_WEIGHT["800"]).toBe("IBMPlexSans_700Bold");
  });

  it("preserves body regular, medium, and semibold weights", () => {
    expect(BODY_FAMILY_BY_WEIGHT["400"]).toBe("IBMPlexSans_400Regular");
    expect(BODY_FAMILY_BY_WEIGHT["500"]).toBe("IBMPlexSans_500Medium");
    expect(BODY_FAMILY_BY_WEIGHT["600"]).toBe("IBMPlexSans_600SemiBold");
  });
});
