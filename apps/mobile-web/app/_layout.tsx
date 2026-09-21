import {
  Archivo_600SemiBold,
  Archivo_700Bold,
  Archivo_800ExtraBold,
} from "@expo-google-fonts/archivo";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
} from "@expo-google-fonts/ibm-plex-sans";
import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Slot } from "expo-router";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";

import { AppText } from "@/components/core/AppText";
import { applySeedFromEnvironment, hasPendingDevSeed, isDevSeedEnabled } from "@/fixtures/devSeed";
import { hydrateCookieJar } from "@/lib/cookieJar";
import { renewSession } from "@/lib/session";
import { queryClient, trpc, trpcClient } from "@/lib/trpc";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { colors } from "@/theme/colors";

// UI-favicon: expo-router/head (react-helmet-async, vendored react-navigation) pulls in
// the real react-native package from inside an unmocked, unaliased require chain — that
// package ships raw Flow syntax (`import typeof … from './index.js.flow'`) neither esbuild
// nor plain Node can parse, so importing expo-router/head crashes any test that renders
// RootLayout. Managing the document head directly sidesteps the dependency and is
// equivalent for a client-hydrated SPA: both approaches set these tags after mount, on
// the web platform only.
function setMetaDescription(content: string): void {
  let tag = document.querySelector('meta[name="description"]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("name", "description");
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setFaviconLink(type: string, href: string, sizes?: string): void {
  let link = document.querySelector(`link[rel="icon"][type="${type}"]`);
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "icon");
    link.setAttribute("type", type);
    document.head.appendChild(link);
  }
  link.setAttribute("href", href);
  if (sizes) {
    link.setAttribute("sizes", sizes);
  }
}

function useDocumentHead(): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    document.title = "Seatfirst • Find your seats";
    setMetaDescription(
      "Find the best available seats at a theatre, fast, and hand off to checkout.",
    );
    setFaviconLink("image/png", "/favicon.png", "32x32");
    setFaviconLink("image/svg+xml", "/favicon.svg", "any");
  }, []);
}

function BootstrapGate({ children }: { children: React.ReactNode }) {
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);
  const bootstrapLoading = useSeatfirstStore((s) => s.bootstrapLoading);
  const bootstrapError = useSeatfirstStore((s) => s.bootstrapError);
  const setBootstrapLoading = useSeatfirstStore((s) => s.setBootstrapLoading);
  const setBootstrapError = useSeatfirstStore((s) => s.setBootstrapError);

  const [hydrated, setHydrated] = useState(false);
  const bootstrappingRef = useRef(false);

  useEffect(() => {
    void hydrateCookieJar().then(() => setHydrated(true));
  }, []);

  const runBootstrap = async () => {
    if (bootstrappingRef.current) return;
    bootstrappingRef.current = true;
    setBootstrapLoading(true);
    setBootstrapError(null);
    try {
      await renewSession();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to connect";
      setBootstrapError(message);
      setBootstrapLoading(false);
    } finally {
      bootstrappingRef.current = false;
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    if (bootstrapReady) return;
    if (bootstrapLoading) return;
    if (bootstrapError) return; // wait for manual retry
    void runBootstrap();
    // runBootstrap is stable for the app lifetime; including it would trigger
    // re-bootstrap on every render, so it is intentionally omitted from deps.
  }, [hydrated, bootstrapReady, bootstrapLoading, bootstrapError]);

  if (!hydrated || (!bootstrapReady && bootstrapLoading)) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.pageBg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator size="large" color={colors.brandDark} />
        <AppText style={{ marginTop: 12, color: colors.textMuted }}>Connecting…</AppText>
      </View>
    );
  }

  if (bootstrapError && !bootstrapReady) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.pageBg,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <AppText
          weight="600"
          style={{ color: colors.textPrimary, marginBottom: 8, textAlign: "center" }}
        >
          Unable to connect
        </AppText>
        <AppText style={{ color: colors.textMuted, marginBottom: 16, textAlign: "center" }}>
          {bootstrapError}
        </AppText>
        <Pressable
          onPress={() => void runBootstrap()}
          style={{
            backgroundColor: colors.brandDark,
            paddingHorizontal: 20,
            paddingVertical: 10,
            borderRadius: 8,
          }}
        >
          <AppText weight="600" style={{ color: "#fff" }}>
            Retry
          </AppText>
        </Pressable>
      </View>
    );
  }

  return <>{children}</>;
}

/**
 * Dev-only scenario seeding (`?seed=<id>` on web, `EXPO_PUBLIC_SEED` on native).
 *
 * The picker and its fixtures are dynamically imported so they stay out of the initial
 * bundle. `seedSettled` starts true whenever nothing was asked for — so a normal dev or
 * production run is untouched — and otherwise holds `BootstrapGate` back until the store
 * is seeded, so a seeded screen never fires the bootstrap request it does not need. It
 * settles even when the id is unknown, so a typo falls through to real bootstrap rather
 * than hanging on the splash.
 */
function useDevSeed(): { DevSeedBar: ComponentType | null; seedSettled: boolean } {
  const [DevSeedBar, setDevSeedBar] = useState<ComponentType | null>(null);
  const [seedSettled, setSeedSettled] = useState(() => !hasPendingDevSeed());

  useEffect(() => {
    if (!isDevSeedEnabled()) return;
    void applySeedFromEnvironment().finally(() => setSeedSettled(true));
    void import("@/components/dev/DevSeedBar").then((module) => {
      setDevSeedBar(() => module.DevSeedBar as ComponentType);
    });
  }, []);

  return { DevSeedBar, seedSettled };
}

export default function RootLayout() {
  useDocumentHead();
  const { DevSeedBar, seedSettled } = useDevSeed();
  const [fontsLoaded] = useFonts({
    Archivo_600SemiBold,
    Archivo_700Bold,
    Archivo_800ExtraBold,
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSans_700Bold,
  });

  if (!fontsLoaded || !seedSettled) {
    return <View style={{ flex: 1, backgroundColor: colors.pageBg }} />;
  }

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.pageBg }}>
          <BootstrapGate>
            <Slot />
          </BootstrapGate>
          {DevSeedBar ? <DevSeedBar /> : null}
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
