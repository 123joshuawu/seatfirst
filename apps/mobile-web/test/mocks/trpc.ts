/**
 * Typed tRPC surface mocks for UI9 — covers every hook UI2/UI3/UI6 expose.
 * No live backend; consumers configure return values per scenario via vi.fn().
 */
import { vi } from "vitest";

// searches.*
export const mockCreateMutate = vi.fn<(...args: unknown[]) => unknown>();
export const mockGetQuery = vi.fn<(...args: unknown[]) => unknown>();
export const mockCancelMutate = vi.fn<(...args: unknown[]) => unknown>();
export const mockOnProgressSubscribe = vi.fn<(...args: unknown[]) => unknown>();

// session.*
export const mockBootstrapMutate = vi.fn<(...args: unknown[]) => unknown>();

// theatres.*
export const mockTheatresSearchQuery = vi.fn<(...args: unknown[]) => unknown>();
export const mockTheatresMoviesQuery = vi.fn<(...args: unknown[]) => unknown>();

// showtimes.*
export const mockRecheckMutate = vi.fn<(...args: unknown[]) => unknown>();

export function resetTrpcMocks(): void {
  mockCreateMutate.mockReset();
  mockGetQuery.mockReset();
  mockCancelMutate.mockReset();
  mockOnProgressSubscribe.mockReset();
  mockBootstrapMutate.mockReset();
  mockTheatresSearchQuery.mockReset();
  mockTheatresMoviesQuery.mockReset();
  mockRecheckMutate.mockReset();
}

/**
 * Install the global vi.mock for "@/lib/trpc" — call this from a test file's
 * top-level `vi.mock` factory via `vi.mock("@/lib/trpc", () => createTrpcMock())`.
 * We also re-export for manual `vi.mocked(trpc)` usage.
 */
export function createTrpcMock() {
  return {
    trpc: {
      searches: {
        create: { mutate: (...args: unknown[]) => mockCreateMutate(...args) },
        get: { query: (...args: unknown[]) => mockGetQuery(...args) },
        cancel: { mutate: (...args: unknown[]) => mockCancelMutate(...args) },
        onProgress: { subscribe: (...args: unknown[]) => mockOnProgressSubscribe(...args) },
      },
      session: {
        bootstrap: { mutate: (...args: unknown[]) => mockBootstrapMutate(...args) },
      },
      theatres: {
        search: { query: (...args: unknown[]) => mockTheatresSearchQuery(...args) },
        movies: { query: (...args: unknown[]) => mockTheatresMoviesQuery(...args) },
      },
      showtimes: {
        recheck: { mutate: (...args: unknown[]) => mockRecheckMutate(...args) },
      },
    },
    getTrpcUrl: () => "http://localhost:3000/trpc",
    queryClient: { clear: vi.fn() },
  };
}
