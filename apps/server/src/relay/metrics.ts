import type { Meter } from "@opentelemetry/api";

import type { RelayState } from "./state.js";

/**
 * OTel instrument names owned by the relay daemon (S9.5, S9.6).
 *
 * O1 (`packages/config/src/otel.ts`'s `OTEL_METRIC_DEFINITIONS`) owns the architecture
 * §10.1 metric set; these four are the relay's own instruments, which S9's spec assigns
 * to this daemon. Names follow O1's `seatfirst.` prefix convention. No thresholds are
 * encoded here: the alarm comparison happens in `runRelayLoop` against the
 * caller-supplied `alarmThresholdMs` (gate 14).
 */
export const RELAY_METRIC_NAMES = {
  /** S9.6 — current PENDING backlog depth, mirrored on GET /healthz. */
  pendingDepth: "seatfirst.outbox.pending.depth",
  /** S9.5 — age of the oldest PENDING row: the "committed but never dispatched" signal. */
  oldestPendingAge: "seatfirst.outbox.pending.oldest_age",
  /** S9.5 — 1 when `oldestPendingAge` exceeds the caller-supplied threshold, else 0. */
  pendingAlarm: "seatfirst.outbox.pending.alarm",
  /** S9.6 — epoch ms of the last successful poll; no data point before the first. */
  lastSuccessfulPoll: "seatfirst.relay.last_successful_poll",
} as const;

/**
 * Registers observable gauges that pull from the shared {@link RelayState}, so the
 * observability pipeline records the relay's liveness without a separate dashboard
 * (O1 wires the SDK; it does not own dashboards — S9.6).
 */
export function registerRelayMetrics(meter: Meter, state: RelayState): void {
  meter
    .createObservableGauge(RELAY_METRIC_NAMES.pendingDepth, {
      unit: "{row}",
      description: "Count of outbox rows in state = 'PENDING', as seen by the relay.",
    })
    .addCallback((observer) => observer.observe(state.pendingBacklogDepth));
  meter
    .createObservableGauge(RELAY_METRIC_NAMES.oldestPendingAge, {
      unit: "ms",
      description:
        "Age of the oldest PENDING outbox row; 0 while the outbox is drained. " +
        "The 'committed but never dispatched' alarm input (architecture §4.1).",
    })
    .addCallback((observer) => observer.observe(state.oldestPendingAgeMs));
  meter
    .createObservableGauge(RELAY_METRIC_NAMES.pendingAlarm, {
      unit: "1",
      description:
        "1 while the oldest PENDING row is older than the configured alarm threshold, " +
        "else 0. The threshold is caller-supplied; this module encodes no number.",
    })
    .addCallback((observer) => observer.observe(state.alarmActive ? 1 : 0));
  meter
    .createObservableGauge(RELAY_METRIC_NAMES.lastSuccessfulPoll, {
      unit: "ms",
      description: "Epoch milliseconds of the relay's last successful poll cycle.",
    })
    .addCallback((observer) => {
      if (state.lastSuccessfulPollAt !== null) {
        observer.observe(state.lastSuccessfulPollAt.getTime());
      }
    });
}
