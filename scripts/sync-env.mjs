#!/usr/bin/env node
// Keeps ADR 0046's local env-file pairs synchronized with their tracked templates without
// ever printing or overwriting an operator value. This deliberately implements only the
// file-maintenance contract; Docker Secrets and *_FILE readers are out of scope.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const TARGETS = {
  prod: {
    configTemplate: ".env.example",
    secretsTemplate: ".env.secrets.example",
    configFile: ".env",
    secretsFile: ".env.secrets",
  },
  dev: {
    configTemplate: ".env.dev.example",
    secretsTemplate: ".env.dev.secrets.example",
    configFile: ".env.dev",
    secretsFile: ".env.dev.secrets",
  },
};

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function parseDotenv(text, label) {
  const values = new Map();
  const duplicates = [];
  for (const [index, line] of text.split("\n").entries()) {
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (values.has(key)) duplicates.push(`${label}:${index + 1} duplicates ${key}`);
    else values.set(key, value);
  }
  return { values, duplicates };
}

function pairDuplicates(left, right) {
  return [...left.values.keys()]
    .filter((key) => right.values.has(key))
    .map((key) => `${key} appears in both files`);
}

function appendMissing(file, currentText, template, missing) {
  const additions = missing.map((key) => `${key}=${template.values.get(key)}`).join("\n");
  const prefix =
    currentText === "" || currentText.endsWith("\n") ? currentText : `${currentText}\n`;
  appendFileSync(file, `${prefix}${additions}\n`);
}
// I7.2 — a required key (a template key with a non-empty template value, OR a key in
// ALWAYS_REQUIRED_KEYS whose template is deliberately blank as an operator-injection
// reminder rather than an optional default) must be non-blank in --check mode. Keys
// whose template value is itself empty and NOT in ALWAYS_REQUIRED_KEYS (documented
// optional overrides such as OTEL_EXPORTER_OTLP_ENDPOINT) may stay blank. Missing keys
// are reported separately; only present-but-blank keys land here. Every template that
// needs a real operator-supplied value spells its placeholder with the literal
// substring "replace-me" (e.g. "replace-me", "replace-me-strong-password"); a local
// value still containing that substring counts as blank — the operator copied the
// template verbatim without supplying a real value. A local value that merely equals
// a template's own concrete, usable default (e.g. AWS_REGION=us-east-1) is NOT
// blank — operators are not required to change values that are already correct.
// Surrounding quotes are stripped before comparison so `KEY=""` is treated like `KEY=`.
function unquote(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
const ALWAYS_REQUIRED_KEYS = new Set([
  // ADR 0005 §H / ADR 0006: the archive-lag alert threshold is a required production
  // value, but its template line is deliberately left blank (`.env.example`) so the
  // Postgres healthcheck fails loudly until the operator supplies the real number.
  "SEATFIRST_ARCHIVE_LAG_ALERT",
]);
const PLACEHOLDER_PATTERN = /replace-me/i;
function blankKeys(template, local) {
  return [...template.values.entries()]
    .filter(([key, templateValue]) => {
      if (!local.values.has(key)) return false;
      const templateRaw = unquote(templateValue);
      const required = templateRaw !== "" || ALWAYS_REQUIRED_KEYS.has(key);
      if (!required) return false;
      const localRaw = unquote(local.values.get(key));
      return localRaw === "" || PLACEHOLDER_PATTERN.test(localRaw);
    })
    .map(([key]) => key);
}

// I7.2 — ADR 0072 §1 mandates these deployment credentials live in .env.secrets,
// but they are consumed by scripts/ops/*.sh, never by Compose, so the templates
// declare no entry for them. --check tolerates (never requires) them in the prod
// secrets file instead of failing them as unclassified. Anything else untemplated
// still fails. If these keys are ever added to .env.secrets.example, delete this set.
const CHECK_TOLERATED_SECRETS = new Set(["GHCR_PULL_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
/**
 * Synchronizes one target. `root` and `write` make this deterministic and testable without
 * exposing local values. Returns diagnostics containing only key names and file labels.
 */
export function synchronize(
  targetName,
  { root = process.cwd(), check = false, write = true } = {},
) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`Unknown target ${JSON.stringify(targetName)}; use prod or dev.`);
  const paths = Object.fromEntries(
    Object.entries(target).map(([name, file]) => [name, path.join(root, file)]),
  );
  const configTemplate = parseDotenv(readText(paths.configTemplate), target.configTemplate);
  const secretsTemplate = parseDotenv(readText(paths.secretsTemplate), target.secretsTemplate);
  const config = parseDotenv(readText(paths.configFile), target.configFile);
  const secrets = parseDotenv(readText(paths.secretsFile), target.secretsFile);

  const errors = [
    ...configTemplate.duplicates,
    ...secretsTemplate.duplicates,
    ...pairDuplicates(configTemplate, secretsTemplate),
    ...config.duplicates,
    ...secrets.duplicates,
    ...pairDuplicates(config, secrets),
  ];
  const templateKeys = new Set([...configTemplate.values.keys(), ...secretsTemplate.values.keys()]);
  const unknown = [...config.values.keys(), ...secrets.values.keys()].filter(
    (key) => !templateKeys.has(key),
  );
  const misplaced = [
    ...[...config.values.keys()].filter((key) => secretsTemplate.values.has(key)),
    ...[...secrets.values.keys()].filter((key) => configTemplate.values.has(key)),
  ];
  const configMissing = [...configTemplate.values.keys()].filter((key) => !config.values.has(key));
  const secretsMissing = [...secretsTemplate.values.keys()].filter(
    (key) => !secrets.values.has(key),
  );
  const configBlank = blankKeys(configTemplate, config);
  const secretsBlank = blankKeys(secretsTemplate, secrets);

  // Tolerated deployment credentials (above) are exempt from the unclassified failure,
  // prod secrets file only — in both --check and write mode, so write mode does not
  // abort before appending new template keys just because these three keys are present.
  const effectiveUnknown = unknown.filter(
    (key) =>
      !(targetName === "prod" && secrets.values.has(key) && CHECK_TOLERATED_SECRETS.has(key)),
  );

  // A duplicate means the partition is ambiguous. Never append placeholders while that
  // contract violation exists, even in write mode.
  if (check) {
    if (configMissing.length)
      errors.push(`missing from ${target.configFile}: ${configMissing.join(", ")}`);
    if (secretsMissing.length)
      errors.push(`missing from ${target.secretsFile}: ${secretsMissing.join(", ")}`);
    if (configBlank.length)
      errors.push(`blank value in ${target.configFile}: ${configBlank.join(", ")}`);
    if (secretsBlank.length)
      errors.push(`blank value in ${target.secretsFile}: ${secretsBlank.join(", ")}`);
    if (effectiveUnknown.length)
      errors.push(`unclassified local keys: ${effectiveUnknown.join(", ")}`);
    if (misplaced.length) errors.push(`keys in the wrong local file: ${misplaced.join(", ")}`);
  } else if (write) {
    if (effectiveUnknown.length)
      errors.push(`unclassified local keys: ${effectiveUnknown.join(", ")}`);
    if (misplaced.length) errors.push(`keys in the wrong local file: ${misplaced.join(", ")}`);
    if (errors.length)
      return { errors, unknown, configMissing, secretsMissing, configBlank, secretsBlank };
    if (configMissing.length)
      appendMissing(paths.configFile, readText(paths.configFile), configTemplate, configMissing);
    if (secretsMissing.length)
      appendMissing(
        paths.secretsFile,
        readText(paths.secretsFile),
        secretsTemplate,
        secretsMissing,
      );
  }

  return { errors, unknown, configMissing, secretsMissing, configBlank, secretsBlank };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const positional = args.filter((arg) => arg !== "--check");
  if (positional.length !== 1 || args.some((arg) => arg !== "--check" && arg !== positional[0])) {
    throw new Error("Usage: scripts/sync-env.mjs <prod|dev> [--check]");
  }
  const target = positional[0];
  const result = synchronize(target, { check });
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  if (check) {
    console.log(`${target} env files match their templates.`);
    return;
  }
  if (result.configMissing.length || result.secretsMissing.length) {
    console.log(`${target} env files updated with missing template keys.`);
  } else {
    console.log(`${target} env files already contain every template key.`);
  }
  if (result.unknown.length) console.warn(`Unclassified local keys: ${result.unknown.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
