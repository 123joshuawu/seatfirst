import type { FastifyInstance } from "fastify";

import type { RelayState } from "./state.js";

/**
 * `GET /healthz` — the architecture route table's internal liveness endpoint
 * (`docs/seatfirst-architecture.md:277`), consumed by the Docker Compose healthcheck
 * (S9.6). Reports the relay's own in-memory state: the last successful poll timestamp
 * and the current PENDING backlog depth. The same values are mirrored as OTel gauges
 * (`metrics.ts`), so the observability pipeline records them without a dashboard (O1
 * wires the SDK; it owns no dashboards).
 *
 * The handler applies no staleness policy: the process answering at all is the
 * liveness signal, and the body carries the freshness data for whatever consumes it.
 * Inventing a "stale after N ms ⇒ 503" rule would be a numeric threshold nobody has
 * written down (gate 14 / `docs/gates.md:1-5`).
 */
export interface HealthzBody {
  readonly lastSuccessfulPollAt: string | null;
  readonly pendingBacklogDepth: number;
}

export function registerHealthz(fastify: FastifyInstance, state: RelayState): void {
  fastify.get("/healthz", (): HealthzBody => ({
    lastSuccessfulPollAt:
      state.lastSuccessfulPollAt === null ? null : state.lastSuccessfulPollAt.toISOString(),
    pendingBacklogDepth: state.pendingBacklogDepth,
  }));
}
