import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/**
 * Real-state test infrastructure, mirroring the durability harness's contract
 * (`packages/durability/test/support/global-setup.ts`): tests run against real Postgres 16
 * and Redis 7, from testcontainers unless a pre-provisioned instance is injected.
 *
 * Env overrides:
 * - `SERVER_PG_URL`   — use an existing Postgres URL instead of testcontainers. The URL's
 *                       user must be able to run the durability migrations and TRUNCATE
 *                       `search` (this suite drops no databases).
 * - `SERVER_REDIS_URL` — use an existing Redis URL instead of testcontainers. The suite
 *                        never FLUSHes: streams are per-search keys and tests use unique
 *                        search ids, so an external instance is safe to share.
 */

const PG_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

export interface TestService {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestService> {
  const override = process.env["SERVER_PG_URL"];
  if (override !== undefined) {
    return { url: override, stop: () => Promise.resolve() };
  }
  const container = await new PostgreSqlContainer(PG_IMAGE).start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startTestRedis(): Promise<TestService> {
  const override = process.env["SERVER_REDIS_URL"];
  if (override !== undefined) {
    return { url: override, stop: () => Promise.resolve() };
  }
  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    const started = container;
    return {
      url: `redis://${started.getHost()}:${started.getMappedPort(6379)}`,
      stop: async () => {
        await started.stop();
      },
    };
  } catch (cause) {
    await container?.stop();
    throw cause;
  }
}
