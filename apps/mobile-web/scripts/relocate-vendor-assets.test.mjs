import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relocateVendorAssets } from "./relocate-vendor-assets.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "seatfirst-relocate-vendor-assets-"));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Builds a dist/ tree shaped like a real Expo web export with a pnpm-nested font. */
function buildPnpmFixture(distDir) {
  const fontDir = path.join(
    distDir,
    "assets/__node_modules/.pnpm/@expo-google-fonts+archivo@0.4.2/node_modules/@expo-google-fonts/archivo/700Bold",
  );
  mkdirSync(fontDir, { recursive: true });
  writeFileSync(path.join(fontDir, "Archivo_700Bold.abc123.ttf"), "fake-font-bytes");

  const fontUrl =
    "assets/__node_modules/.pnpm/@expo-google-fonts+archivo@0.4.2/node_modules/@expo-google-fonts/archivo/700Bold/Archivo_700Bold.abc123.ttf";
  mkdirSync(path.join(distDir, "_expo/static/js/web"), { recursive: true });
  writeFileSync(
    path.join(distDir, "index.html"),
    `<html><head><style>@font-face{src:url(/${fontUrl})}</style></head></html>`,
  );
  writeFileSync(
    path.join(distDir, "_expo/static/js/web/entry-deadbeef.js"),
    `var FONT="/${fontUrl}";console.log(FONT);`,
  );
  return { fontUrl };
}

describe("relocateVendorAssets", () => {
  it("renames a hidden pnpm directory and rewrites every html/js reference to it", () => {
    const distDir = fixture();
    buildPnpmFixture(distDir);

    relocateVendorAssets(distDir);

    // The hidden directory is gone; its de-hidden replacement exists with the font intact.
    expect(
      statSync(path.join(distDir, "assets/__node_modules/.pnpm"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    const relocated = path.join(
      distDir,
      "assets/__node_modules/_pnpm/@expo-google-fonts+archivo@0.4.2/node_modules/@expo-google-fonts/archivo/700Bold/Archivo_700Bold.abc123.ttf",
    );
    expect(readFileSync(relocated, "utf8")).toBe("fake-font-bytes");

    // Every reference across both html and js output now points at the new path,
    // and the old hidden segment appears nowhere.
    const html = readFileSync(path.join(distDir, "index.html"), "utf8");
    const js = readFileSync(path.join(distDir, "_expo/static/js/web/entry-deadbeef.js"), "utf8");
    expect(html).toContain("/assets/__node_modules/_pnpm/@expo-google-fonts+archivo@0.4.2/");
    expect(js).toContain("/assets/__node_modules/_pnpm/@expo-google-fonts+archivo@0.4.2/");
    expect(html).not.toContain("/.pnpm/");
    expect(js).not.toContain("/.pnpm/");
  });

  it("is a no-op when dist/assets has no hidden directories", () => {
    const distDir = fixture();
    mkdirSync(path.join(distDir, "assets/plain-dir"), { recursive: true });
    writeFileSync(path.join(distDir, "assets/plain-dir/file.ttf"), "bytes");
    writeFileSync(path.join(distDir, "index.html"), "<html></html>");

    expect(() => relocateVendorAssets(distDir)).not.toThrow();

    expect(statSync(path.join(distDir, "assets/plain-dir/file.ttf")).isFile()).toBe(true);
  });

  it("is a no-op when dist has no assets directory at all", () => {
    const distDir = fixture();
    writeFileSync(path.join(distDir, "index.html"), "<html></html>");

    expect(() => relocateVendorAssets(distDir)).not.toThrow();
  });

  it("throws instead of silently overwriting an existing de-hidden directory", () => {
    const distDir = fixture();
    mkdirSync(path.join(distDir, "assets/__node_modules/.pnpm"), { recursive: true });
    // A colliding directory already occupies the rename target.
    mkdirSync(path.join(distDir, "assets/__node_modules/_pnpm"), { recursive: true });

    expect(() => relocateVendorAssets(distDir)).toThrow(/refusing to overwrite/);
  });
});
