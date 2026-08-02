#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, readFlag, repositoryRoot } from "./lib/config.mjs";
import { generateProfileReadme } from "./lib/readme.mjs";

try {
  const config = await loadConfig(readFlag("--config"));
  const manifestPath = resolve(repositoryRoot, "assets/hero/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let contributionManifest;
  try {
    contributionManifest = JSON.parse(await readFile(resolve(repositoryRoot, "assets/activity/manifest.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await generateProfileReadme({ config, manifest, contributionManifest, readmePath: resolve(repositoryRoot, "README.md") });
  console.log("Generated README.md from profile.config.json.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
