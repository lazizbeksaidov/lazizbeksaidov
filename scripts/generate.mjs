#!/usr/bin/env node

import { resolve } from "node:path";
import { loadConfig, readFlag, repositoryRoot } from "./lib/config.mjs";
import { generateContributionAssets } from "./lib/contributions.mjs";
import { generateHeroAssets } from "./lib/hero.mjs";
import { generateProfileReadme } from "./lib/readme.mjs";

const source = readFlag("--source");
if (!source) {
  console.error("Usage: npm run generate -- --source /absolute/path/to/transparent-portrait.png");
  process.exit(1);
}

try {
  const config = await loadConfig(readFlag("--config"));
  const manifest = await generateHeroAssets({
    config,
    sourcePath: resolve(source),
    outputDirectory: resolve(repositoryRoot, "assets/hero")
  });
  const contributionManifest = config.activity.enabled
    ? await generateContributionAssets({ config, outputDirectory: resolve(repositoryRoot, "assets/activity") })
    : undefined;
  await generateProfileReadme({ config, manifest, contributionManifest, readmePath: resolve(repositoryRoot, "README.md") });
  const activityVersion = contributionManifest ? `, activity ${contributionManifest.version}` : "";
  console.log(`Profile generated successfully (hero ${manifest.version}${activityVersion}).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
