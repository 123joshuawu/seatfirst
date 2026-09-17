import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDotenv, synchronize } from "./sync-env.mjs";

const roots = [];
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "seatfirst-sync-env-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files))
    writeFileSync(path.join(root, file), content);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("parseDotenv", () => {
  it("records duplicate assignment keys without treating comments as assignments", () => {
    const parsed = parseDotenv("# A=x\nA=first\nA=second\n", "fixture");
    expect(parsed.values.get("A")).toBe("first");
    expect(parsed.duplicates).toEqual(["fixture:3 duplicates A"]);
  });
});

describe("synchronize", () => {
  it("appends missing placeholders without replacing existing operator values", () => {
    const root = fixture({
      ".env.example": "CONFIG=replace-me\n",
      ".env.secrets.example": "SECRET=replace-me\n",
      ".env": "CONFIG=operator-value\n",
      ".env.secrets": "",
    });
    const result = synchronize("prod", { root });
    expect(result.errors).toEqual([]);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("CONFIG=operator-value\n");
    expect(readFileSync(path.join(root, ".env.secrets"), "utf8")).toBe("SECRET=replace-me\n");
  });

  it("check reports missing and unclassified keys without writing either file", () => {
    const root = fixture({
      ".env.example": "CONFIG=replace-me\n",
      ".env.secrets.example": "SECRET=replace-me\n",
      ".env": "UNKNOWN=operator-value\n",
      ".env.secrets": "SECRET=operator-secret\n",
    });
    const result = synchronize("prod", { root, check: true });
    expect(result.errors.join("\n")).toMatch(/missing from .env: CONFIG/);
    expect(result.errors.join("\n")).toMatch(/unclassified local keys: UNKNOWN/);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("UNKNOWN=operator-value\n");
  });

  it("rejects a key that straddles the configuration and secret partitions", () => {
    const root = fixture({
      ".env.example": "SHARED=replace-me\n",
      ".env.secrets.example": "SHARED=replace-me\n",
      ".env": "",
      ".env.secrets": "",
    });
    expect(synchronize("prod", { root, check: true }).errors).toContain(
      "SHARED appears in both files",
    );
  });

  it("does not write placeholders when a duplicate makes the partition ambiguous", () => {
    const root = fixture({
      ".env.example": "CONFIG=replace-me\n",
      ".env.secrets.example": "CONFIG=replace-me\nSECRET=replace-me\n",
      ".env": "",
      ".env.secrets": "",
    });
    expect(synchronize("prod", { root }).errors).toContain("CONFIG appears in both files");
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("");
    expect(readFileSync(path.join(root, ".env.secrets"), "utf8")).toBe("");
  });

  it("check accepts a required key left at its concrete, usable template default", () => {
    const root = fixture({
      ".env.example": "CONFIG=replace-me\nAWS_REGION=us-east-1\n",
      ".env.secrets.example": "SECRET=replace-me\n",
      ".env": "CONFIG=operator-value\nAWS_REGION=us-east-1\n",
      ".env.secrets": "SECRET=operator-secret\n",
    });
    expect(synchronize("prod", { root, check: true }).errors).toEqual([]);
  });

  it("check rejects a required key still holding its replace-me placeholder", () => {
    const root = fixture({
      ".env.example": "CONFIG=replace-me\n",
      ".env.secrets.example": "SECRET=replace-me-strong-password\n",
      ".env": "CONFIG=replace-me\n",
      ".env.secrets": "SECRET=replace-me-strong-password\n",
    });
    const result = synchronize("prod", { root, check: true });
    expect(result.errors.join("\n")).toMatch(/blank value in \.env: CONFIG/);
    expect(result.errors.join("\n")).toMatch(/blank value in \.env\.secrets: SECRET/);
  });
});
