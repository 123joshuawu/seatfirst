/**
 * The relay daemon's in-memory liveness state (S9.6).
 *
 * Written by the poll loop after every completed cycle and read by the `GET /healthz`
 * route and the OTel observable gauges registered by `metrics.ts`. Deliberately
 * process-local and non-durable: the outbox table in Postgres is the sole source of
 * truth (S9.8), and this object only mirrors the relay's own view of it.
 */
export interface RelayState {
  /** Timestamp of the last poll cycle that completed; null until the first one. */
  lastSuccessfulPollAt: Date | null;
  /** Count of outbox rows in state = 'PENDING', as of the last completed poll. */
  pendingBacklogDepth: number;
  /** Age in ms of the oldest PENDING outbox row; 0 when the outbox is drained. */
  oldestPendingAgeMs: number;
  /** True when `oldestPendingAgeMs` exceeds the caller-supplied alarm threshold. */
  alarmActive: boolean;
}

export function createRelayState(): RelayState {
  return {
    lastSuccessfulPollAt: null,
    pendingBacklogDepth: 0,
    oldestPendingAgeMs: 0,
    alarmActive: false,
  };
}
