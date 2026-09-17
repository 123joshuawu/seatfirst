import { beforeEach, vi } from "vitest";

vi.mock("expo-font", () => ({
  useFonts: () => [true],
  loadAsync: vi.fn(async () => {}),
  isLoaded: () => true,
}));

vi.mock("expo-router", () => ({
  Stack: () => null,
  Tabs: () => null,
  Slot: () => null,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSegments: () => [],
  usePathname: () => "/",
  Link: () => null,
  Redirect: () => null,
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} }, manifest: { extra: {} } },
}));

beforeEach(() => {
  const g = globalThis as unknown as { __rntlAppStateHandlers?: unknown[] };
  if (g.__rntlAppStateHandlers) g.__rntlAppStateHandlers.length = 0;
});
