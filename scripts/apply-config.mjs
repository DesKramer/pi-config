#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configDir = join(repoRoot, "config");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function backup(path) {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.bak-${stamp}`);
}

function uniqueArray(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function mergeSettings(existing, managed) {
  const merged = { ...existing, ...managed };

  // Packages should be additive so machine-local packages are preserved.
  if (Array.isArray(existing.packages) || Array.isArray(managed.packages)) {
    merged.packages = uniqueArray([...(existing.packages ?? []), ...(managed.packages ?? [])]);
  }

  // These are intentionally machine-local. This repo does not manage them.
  for (const key of ["skills", "extensions", "prompts", "themes", "lastChangelogVersion", "trackingId"]) {
    if (Object.prototype.hasOwnProperty.call(existing, key) && !Object.prototype.hasOwnProperty.call(managed, key)) {
      merged[key] = existing[key];
    }
  }

  return merged;
}

function mergeModels(existing, managed) {
  return {
    ...existing,
    ...managed,
    providers: {
      ...(existing.providers ?? {}),
      ...(managed.providers ?? {}),
    },
  };
}

mkdirSync(piDir, { recursive: true });

const settingsSource = join(configDir, "settings.json");
if (existsSync(settingsSource)) {
  const target = join(piDir, "settings.json");
  const existing = existsSync(target) ? readJson(target) : {};
  const managed = readJson(settingsSource);
  backup(target);
  writeJson(target, mergeSettings(existing, managed));
  console.log(`Applied settings -> ${target}`);
}

const modelsSource = join(configDir, "models.json");
if (existsSync(modelsSource)) {
  const target = join(piDir, "models.json");
  const existing = existsSync(target) ? readJson(target) : {};
  const managed = readJson(modelsSource);
  backup(target);
  writeJson(target, mergeModels(existing, managed));
  console.log(`Applied custom providers -> ${target}`);
}

console.log("Done. Restart pi or run /reload in an existing session.");
