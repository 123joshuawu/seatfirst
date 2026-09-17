/** Dependency-free deterministic randomness for tier 6. Never use Math.random here. */

/** Fixed seeds are always exercised in CI; an override is appended for one-off replay. */
export const FIXED_REGRESSION_SEEDS = [0x1a2b3c4d, 0xc0ffee42] as const;

export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

/** Mulberry32: small, deterministic, and sufficient for bounded test-plan generation. */
export class SeededRandom {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error(`random seed must be an integer: ${seed}`);
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Uniform unsigned 32-bit integer. */
  nextInteger(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  /** Inclusive integer range. */
  integer(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new Error(`invalid integer range [${min}, ${max}]`);
    }
    const width = max - min + 1;
    if (width > 0x1_0000_0000) throw new Error(`integer range is wider than uint32`);
    return min + Math.floor((this.nextInteger() / 0x1_0000_0000) * width);
  }

  /** Half-open integer range, matching array/string index conventions. */
  range(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) {
      throw new Error(`invalid half-open range [${minInclusive}, ${maxExclusive})`);
    }
    return this.integer(minInclusive, maxExclusive - 1);
  }

  /** Select one item from a non-empty range. */
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error("cannot select from an empty range");
    return values[this.range(0, values.length)] as T;
  }

  weighted<T>(choices: readonly Weighted<T>[]): T {
    if (choices.length === 0) throw new Error("cannot select from empty weighted choices");
    const total = choices.reduce((sum, choice) => {
      if (!Number.isFinite(choice.weight) || choice.weight <= 0) {
        throw new Error(`weight must be finite and positive: ${choice.weight}`);
      }
      return sum + choice.weight;
    }, 0);
    let target = (this.nextInteger() / 0x1_0000_0000) * total;
    for (const choice of choices) {
      target -= choice.weight;
      if (target < 0) return choice.value;
    }
    return choices[choices.length - 1]!.value;
  }

  /** Fisher-Yates copy; the caller's input is never mutated. */
  shuffle<T>(values: readonly T[]): T[] {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = this.integer(0, index);
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    return shuffled;
  }
}

export function parseRandomSeed(raw: string): number {
  const normalized = raw.trim();
  if (!/^(?:0x[\da-f]+|\d+)$/iu.test(normalized)) {
    throw new Error(`DURABILITY_RANDOM_SEED must be an unsigned decimal or hex integer: ${raw}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`DURABILITY_RANDOM_SEED must fit uint32: ${raw}`);
  }
  return parsed >>> 0;
}

/** Fixed regressions plus an optional explicit replay seed (deduplicated). */
export function regressionSeeds(env = process.env): readonly number[] {
  const seeds: number[] = [...FIXED_REGRESSION_SEEDS];
  const raw = env["DURABILITY_RANDOM_SEED"];
  if (raw !== undefined) {
    const seed = parseRandomSeed(raw);
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  return seeds;
}

/** Stable diagnostic included in every randomized failure. */
export function replayDiagnostic(seed: number, plan: unknown): string {
  return JSON.stringify(
    {
      seed: seed >>> 0,
      seedHex: `0x${(seed >>> 0).toString(16).padStart(8, "0")}`,
      replay:
        `DURABILITY_RANDOM_SEED=${seed >>> 0} pnpm --filter @seatfirst/durability exec vitest run ` +
        `test/tier6.invariant.test.ts --testNamePattern "seed ${seed >>> 0}"`,
      plan,
    },
    null,
    2,
  );
}
