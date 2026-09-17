import type { ShowtimeStatus } from "./result-contracts.js";

export function performancePolicy(
  status: ShowtimeStatus,
): "FETCH" | "SKIP_SOLD_OUT" | "FETCH_UNKNOWN" {
  switch (status) {
    case "OPEN":
    case "LOW_AVAILABILITY":
      return "FETCH";
    case "SOLD_OUT":
    case "CANCELED":
      return "SKIP_SOLD_OUT";
    case "UNKNOWN":
      return "FETCH_UNKNOWN";
    default: {
      status satisfies never;
      return "FETCH_UNKNOWN";
    }
  }
}
