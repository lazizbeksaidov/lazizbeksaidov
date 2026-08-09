import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertInk } from "./raster-check.mjs";
import { resolveTheme } from "./theme.mjs";
import { escapeXml } from "./xml.mjs";

const GENERATOR_VERSION = "contribution-console-v4";
const DAY_MS = 86_400_000;
const MAX_DAYS = 371;

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = match[2] ?? match[3] ?? "";
  }
  return attributes;
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

function utcDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function differenceInDays(left, right) {
  return Math.round((utcDate(left) - utcDate(right)) / DAY_MS);
}

function inferLevel(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function calculateStats(days) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const activeDays = days.filter((day) => day.count > 0).length;
  const best = days.reduce((current, day) => day.count > (current?.count ?? -1) ? day : current, null);
  let longestStreak = 0;
  let runningStreak = 0;
  let previousDate;

  for (const day of days) {
    const contiguous = previousDate && differenceInDays(day.date, previousDate) === 1;
    runningStreak = day.count > 0 ? (contiguous ? runningStreak + 1 : 1) : 0;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousDate = day.date;
  }

  const today = new Date().toISOString().slice(0, 10);
  let cursor = days.length - 1;
  if (differenceInDays(today, days[cursor]?.date) > 1) cursor = -1;
  if (days[cursor]?.date === today && days[cursor]?.count === 0) cursor -= 1;
  let currentStreak = 0;
  let nextDate;
  for (; cursor >= 0; cursor -= 1) {
    const day = days[cursor];
    if (day.count === 0 || (nextDate && differenceInDays(nextDate, day.date) !== 1)) break;
    currentStreak += 1;
    nextDate = day.date;
  }

  return {
    total,
    activeDays,
    currentStreak,
    longestStreak,
    bestDay: best ? { date: best.date, count: best.count } : { date: days.at(-1)?.date, count: 0 }
  };
}

export function parseContributionHtml(html) {
  const tooltips = new Map();
  for (const match of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.for) tooltips.set(attributes.for, decodeHtml(match[2]));
  }

  const days = [];
  for (const match of html.matchAll(/<td\b[^>]*\bContributionCalendar-day\b[^>]*>/g)) {
    const attributes = parseAttributes(match[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(attributes["data-date"] || "")) continue;
    const tooltip = tooltips.get(attributes.id) || "";
    const countMatch = tooltip.match(/([\d,]+)\s+contributions?/i);
    const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : 0;
    const rawLevel = Number(attributes["data-level"]);
    days.push({
      date: attributes["data-date"],
      count,
      level: Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 4 ? rawLevel : inferLevel(count)
    });
  }

  const uniqueDays = [...new Map(days.map((day) => [day.date, day])).values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_DAYS);
  if (uniqueDays.length < 28) throw new Error("GitHub contribution calendar did not contain enough public day data.");
  return uniqueDays;
}

export async function fetchContributionData(username) {
  const response = await fetch(`https://github.com/users/${encodeURIComponent(username)}/contributions`, {
    headers: { Accept: "text/html", "User-Agent": `${username}-profile-contribution-console` }
  });
  if (!response.ok) throw new Error(`GitHub contribution calendar returned ${response.status} ${response.statusText}.`);
  const days = parseContributionHtml(await response.text());
  return {
    username,
    range: { from: days[0].date, to: days.at(-1).date },
    stats: calculateStats(days),
    days
  };
}

function formatCompactDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(utcDate(value));
}

function formatRangeDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(utcDate(value));
}

function dayCount(value) {
  return `${value} ${value === 1 ? "day" : "days"}`;
}

function monthLabels(days, startX, step, y) {
  const labels = [];
  let previousMonth;
  for (const day of days) {
    const date = utcDate(day.date);
    const month = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (month === previousMonth) continue;
    const week = Math.floor(differenceInDays(day.date, days[0].date) / 7);
    if (week > 0) labels.push(`<text x="${startX + week * step}" y="${y}" class="axis">${date.toLocaleString("en", { month: "short", timeZone: "UTC" })}</text>`);
    previousMonth = month;
  }
  return labels.join("\n");
}


const sizes = {
  desktop: { width: 1180, cell: 12, gap: 4, gridTop: 94, cards: "row", cardKeys: 5, radius: 18 },
  mobile: { width: 580, cell: 8, gap: 2, gridTop: 92, cards: "stack", cardKeys: 3, radius: 16 }
};

function statCards(data, count) {
  const bestLabel = data.stats.bestDay.count > 0
    ? `${data.stats.bestDay.count} on ${formatCompactDate(data.stats.bestDay.date)}`
    : "No public activity";
  const all = [
    ["CONTRIBUTIONS", data.stats.total.toLocaleString("en")],
    ["ACTIVE DAYS", String(data.stats.activeDays)],
    ["BEST DAY", bestLabel],
    ["LONGEST STREAK", dayCount(data.stats.longestStreak)],
    ["CURRENT STREAK", dayCount(data.stats.currentStreak)]
  ];
  return all.slice(0, count);
}

function renderStatCards(data, colors, size, top) {
  const cards = statCards(data, size.cardKeys);

  if (size.cards === "stack") {
    const width = size.width - 56;
    return cards.map(([label, value], index) => {
      const y = top + index * 38;
      return `<g><rect x="28" y="${y}" width="${width}" height="32" rx="8" fill="${colors.raised}" fill-opacity="0.58" stroke="${colors.line}" stroke-opacity="0.16"/>` +
        `<text x="41" y="${y + 21}" class="stat-label">${escapeXml(label)}</text>` +
        `<text x="${28 + width - 13}" y="${y + 21}" text-anchor="end" class="stat-value">${escapeXml(value)}</text></g>`;
    }).join("\n");
  }

  const gap = 10;
  const width = Math.floor((size.width - 56 - gap * (cards.length - 1)) / cards.length);
  return cards.map(([label, value], index) => {
    const x = 28 + index * (width + gap);
    return `<g><rect x="${x}" y="${top}" width="${width}" height="48" rx="8" fill="${colors.raised}" fill-opacity="0.58" stroke="${colors.line}" stroke-opacity="0.16"/>` +
      `<text x="${x + 13}" y="${top + 18}" class="stat-label">${escapeXml(label)}</text>` +
      `<text x="${x + 13}" y="${top + 38}" class="stat-value">${escapeXml(value)}</text></g>`;
  }).join("\n");
}

function planActivity(data, size) {
  const step = size.cell + size.gap;
  const weekCount = Math.max(...data.days.map((day) => Math.floor(differenceInDays(day.date, data.days[0].date) / 7))) + 1;
  const gridWidth = (weekCount - 1) * step + size.cell;
  const startX = Math.round((size.width - gridWidth) / 2);
  const gridHeight = 6 * step + size.cell;
  const cardsTop = size.gridTop + gridHeight + 26;
  const cardsHeight = size.cards === "stack" ? size.cardKeys * 38 - 6 : 48;
  const height = cardsTop + cardsHeight + 26;
  return { step, startX, gridWidth, gridHeight, cardsTop, height };
}

function createContributionSvg(data, colors, size) {
  const plan = planActivity(data, size);
  const { width } = size;
  const { height, startX, step } = plan;

  // No per-cell <title>. Hit-testing never enters the content of an
  // <img>-embedded SVG, so those 365 tooltips could never fire; they were 23%
  // of the file for nothing. The root title/desc still carries the summary.
  const cells = data.days.map((day) => {
    const dayOffset = differenceInDays(day.date, data.days[0].date);
    const week = Math.floor(dayOffset / 7);
    const weekday = utcDate(day.date).getUTCDay();
    const delay = (0.12 + week * 0.02 + weekday * 0.004).toFixed(3);
    return `<rect x="${startX + week * step}" y="${size.gridTop + weekday * step}" width="${size.cell}" height="${size.cell}" rx="${Math.max(2, Math.round(size.cell / 4))}" fill="${colors.scale[day.level]}" class="contribution-cell" style="animation-delay:${delay}s"/>`;
  }).join("\n");

  const rangeLabel = `${formatRangeDate(data.range.from)} — ${formatRangeDate(data.range.to)}`;
  const description = `${data.stats.total} public contributions across ${data.stats.activeDays} active days, with a ${data.stats.longestStreak}-day longest streak.`;
  const axisX = startX - 10;
  const command = size.width > 800
    ? `${data.username}@github ~ % ./contributions --year`
    : "./contributions --year";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(data.username)} public GitHub build activity</title>
<desc id="description">${escapeXml(description)}</desc>
<defs>
  <linearGradient id="activity-background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.surface}"/><stop offset="1" stop-color="${colors.surfaceEnd}"/></linearGradient>
  <linearGradient id="activity-border" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${colors.line}" stop-opacity="0.34"/><stop offset="0.5" stop-color="${colors.accent}"/><stop offset="1" stop-color="${colors.line}" stop-opacity="0.34"/></linearGradient>
  <pattern id="activity-scanlines" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="${colors.accent}" opacity="0.035"/></pattern>
  <style>
    .mono, .axis, .stat-label, .stat-value { font-family: 'Courier New', Consolas, monospace; }
    .command { font-size: 12px; fill: ${colors.textMuted}; }
    .section { font-size: 11px; letter-spacing: 1.8px; fill: ${colors.accent}; font-weight: 700; }
    .axis { font-size: 10px; fill: ${colors.textMuted}; }
    .stat-label { font-size: 9px; letter-spacing: 1px; fill: ${colors.textMuted}; }
    .stat-value { font-size: 13px; fill: ${colors.text}; font-weight: 700; }
    /* forwards, not both: "both" also fills BACKWARDS, so every cell sat at
       18% opacity and 45% scale for its entire delay -- up to 1.44s -- and any
       renderer that ignores CSS animation drew the grid at 18% forever.
       A prefers-reduced-motion guard used to live here. It was removed, not
       lost: the query never matches inside an img-embedded SVG. */
    .contribution-cell { transform-box: fill-box; transform-origin: center; animation: cell-in .42s cubic-bezier(.2,.8,.2,1) forwards; }
    @keyframes cell-in { from { opacity: .35; transform: scale(.55); } to { opacity: 1; transform: scale(1); } }
  </style>
</defs>
<rect width="${width}" height="${height}" rx="${size.radius}" fill="url(#activity-background)"/>
<rect width="${width}" height="${height}" rx="${size.radius}" fill="url(#activity-scanlines)"/>
<rect x="3" y="3" width="${width - 6}" height="34" rx="${size.radius - 2}" fill="${colors.raised}" fill-opacity="0.84"/>
<circle cx="24" cy="20" r="5" fill="${colors.danger}"/><circle cx="42" cy="20" r="5" fill="${colors.warn}"/><circle cx="60" cy="20" r="5" fill="${colors.positive}"/>
<text x="${width / 2}" y="25" text-anchor="middle" class="mono command">${escapeXml(command)}</text>
<text x="28" y="65" class="mono section">PUBLIC.BUILD.LOG / LAST 12 MONTHS</text>
${width > 800 ? `<text x="${width - 28}" y="65" text-anchor="end" class="mono axis">${escapeXml(rangeLabel)}</text>` : ""}
${monthLabels(data.days, startX, step, size.gridTop - 12)}
<text x="${axisX}" y="${size.gridTop + step + 9}" text-anchor="end" class="axis">Mon</text><text x="${axisX}" y="${size.gridTop + 3 * step + 9}" text-anchor="end" class="axis">Wed</text><text x="${axisX}" y="${size.gridTop + 5 * step + 9}" text-anchor="end" class="axis">Fri</text>
${cells}
${renderStatCards(data, colors, size, plan.cardsTop)}
<rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="${size.radius - 2}" fill="none" stroke="url(#activity-border)" stroke-width="2" opacity="0.78"/>
</svg>`;
}

function inkRegions(data, size) {
  const plan = planActivity(data, size);

  // Heatmap ink scales with the data: the median-based counter treats the
  // dominant level-0 cells as background, so only active-day cells reliably
  // register. A fixed 1.5% floor therefore failed sparse-but-real years -- a
  // 5-active-day calendar rasterises at ~1.1% while being drawn perfectly.
  // Derive the floor from the calendar instead: expected ink is roughly
  // activeFraction x cell coverage, and gating at 40% of that keeps 2.5x
  // margin for palette and antialiasing variance while a genuinely blank
  // raster (0.00%) still fails. Dense years clamp back to the original 1.5%.
  const activeFraction = data.days.filter((day) => day.level > 0).length / data.days.length;
  const cellCoverage = (size.cell / (size.cell + size.gap)) ** 2;
  const heatmapFloor = Math.min(0.015, Math.max(0.002, activeFraction * cellCoverage * 0.4));

  const regions = [];
  // A year with zero active days draws no active cells at all, making a
  // correct render numerically indistinguishable from the blank-render bug.
  // Gate on the stats band alone in that case -- its text always draws.
  if (activeFraction > 0) {
    regions.push({ label: "heatmap", x: plan.startX, y: size.gridTop, width: plan.gridWidth, height: plan.gridHeight, minInk: heatmapFloor });
  }
  regions.push({ label: "stats", x: 28, y: plan.cardsTop, width: size.width - 56, height: size.cards === "stack" ? 32 : 48 });
  return regions;
}

async function cleanOldAssets(outputDirectory, currentFiles) {
  const entries = await readdir(outputDirectory).catch(() => []);
  const generatedPattern = /^(?:contribution-console-[a-f0-9]{8}-(?:mobile-)?(?:dark|light)\.svg|contributions-[a-f0-9]{8}\.json)$/;
  await Promise.all(entries
    .filter((entry) => generatedPattern.test(entry) && !currentFiles.includes(entry))
    .map((entry) => unlink(resolve(outputDirectory, entry))));
}

// currentStreak is derived from the wall clock, so hashing it renamed all
// three assets across every UTC midnight for identical input -- which quietly
// broke the repository's own reproducibility claim.
function activityFingerprint(data) {
  const { currentStreak, ...stableStats } = data.stats;
  return { days: data.days.map((day) => [day.date, day.count, day.level]), stats: stableStats };
}

export async function generateContributionAssets({ config, outputDirectory, data, verify = true }) {
  const contributionData = data || await fetchContributionData(config.profile.username);
  const version = createHash("sha256")
    .update(GENERATOR_VERSION)
    .update(config.appearance.palette)
    .update(JSON.stringify(activityFingerprint(contributionData)))
    .digest("hex")
    .slice(0, 8);

  const assets = {
    dark: `contribution-console-${version}-dark.svg`,
    light: `contribution-console-${version}-light.svg`,
    mobileDark: `contribution-console-${version}-mobile-dark.svg`,
    mobileLight: `contribution-console-${version}-mobile-light.svg`,
    data: `contributions-${version}.json`
  };

  const documents = {
    dark: createContributionSvg(contributionData, resolveTheme(config.appearance.palette, "dark"), sizes.desktop),
    light: createContributionSvg(contributionData, resolveTheme(config.appearance.palette, "light"), sizes.desktop),
    mobileDark: createContributionSvg(contributionData, resolveTheme(config.appearance.palette, "dark"), sizes.mobile),
    mobileLight: createContributionSvg(contributionData, resolveTheme(config.appearance.palette, "light"), sizes.mobile)
  };

  const regions = inkRegions(contributionData, sizes.desktop);
  if (verify) {
    await assertInk(documents.dark, regions, assets.dark);
    await assertInk(documents.light, regions, assets.light);
  }

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    ...Object.entries(documents).map(([key, svg]) => writeFile(resolve(outputDirectory, assets[key]), svg)),
    writeFile(resolve(outputDirectory, assets.data), `${JSON.stringify(contributionData, null, 2)}\n`)
  ]);
  await cleanOldAssets(outputDirectory, Object.values(assets));

  const manifest = {
    generator: GENERATOR_VERSION,
    version,
    username: contributionData.username,
    range: contributionData.range,
    stats: contributionData.stats,
    assets,
    regions
  };
  await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
