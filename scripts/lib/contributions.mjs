import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { escapeXml } from "./xml.mjs";

const GENERATOR_VERSION = "contribution-console-v3";
const DAY_MS = 86_400_000;
const MAX_DAYS = 371;

const themes = {
  signal: {
    dark: { backgroundStart: "#020617", backgroundEnd: "#11152F", panel: "#07111F", primary: "#E5E7EB", muted: "#64748B", accent: "#22D3EE", border: "#38BDF8", levels: ["#172033", "#0E7490", "#0891B2", "#22D3EE", "#A5F3FC"] },
    light: { backgroundStart: "#F8FBFF", backgroundEnd: "#F5F3FF", panel: "#FFFFFF", primary: "#172554", muted: "#64748B", accent: "#0891B2", border: "#2563EB", levels: ["#E7EDF5", "#A5F3FC", "#67E8F9", "#0891B2", "#155E75"] }
  },
  ocean: {
    dark: { backgroundStart: "#02131A", backgroundEnd: "#111827", panel: "#061A22", primary: "#E5F6F8", muted: "#6B8791", accent: "#2DD4BF", border: "#38BDF8", levels: ["#16313A", "#115E59", "#0F766E", "#2DD4BF", "#99F6E4"] },
    light: { backgroundStart: "#F4FCFC", backgroundEnd: "#F4F7FF", panel: "#FFFFFF", primary: "#123047", muted: "#64748B", accent: "#0F766E", border: "#0284C7", levels: ["#E5F1F2", "#99F6E4", "#5EEAD4", "#0D9488", "#115E59"] }
  },
  solar: {
    dark: { backgroundStart: "#090D14", backgroundEnd: "#1D1720", panel: "#10141C", primary: "#F3F4F6", muted: "#7C8495", accent: "#F59E0B", border: "#22D3EE", levels: ["#28252A", "#92400E", "#B45309", "#F59E0B", "#FDE68A"] },
    light: { backgroundStart: "#FBFCFE", backgroundEnd: "#FFF8ED", panel: "#FFFFFF", primary: "#292524", muted: "#78716C", accent: "#B45309", border: "#2563EB", levels: ["#EEEAE4", "#FDE68A", "#FCD34D", "#D97706", "#92400E"] }
  }
};

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

function monthLabels(days, startX, step) {
  const labels = [];
  let previousMonth;
  for (const day of days) {
    const date = utcDate(day.date);
    const month = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (month === previousMonth) continue;
    const week = Math.floor(differenceInDays(day.date, days[0].date) / 7);
    if (week > 0) labels.push(`<text x="${startX + week * step}" y="82" class="axis">${date.toLocaleString("en", { month: "short", timeZone: "UTC" })}</text>`);
    previousMonth = month;
  }
  return labels.join("\n");
}

function renderStatCards(data, colors) {
  const bestLabel = data.stats.bestDay.count > 0
    ? `${data.stats.bestDay.count} on ${formatCompactDate(data.stats.bestDay.date)}`
    : "No public activity";
  const cards = [
    ["CONTRIBUTIONS", data.stats.total.toLocaleString("en")],
    ["ACTIVE DAYS", String(data.stats.activeDays)],
    ["CURRENT STREAK", dayCount(data.stats.currentStreak)],
    ["LONGEST STREAK", dayCount(data.stats.longestStreak)],
    ["BEST DAY", bestLabel]
  ];
  const x = 28;
  const gap = 10;
  const width = 216;
  return cards.map(([label, value], index) => {
    const cardX = x + index * (width + gap);
    return `<g><rect x="${cardX}" y="226" width="${width}" height="48" rx="8" fill="${colors.panel}" fill-opacity="0.58" stroke="${colors.border}" stroke-opacity="0.16"/><text x="${cardX + 13}" y="244" class="stat-label">${escapeXml(label)}</text><text x="${cardX + 13}" y="264" class="stat-value">${escapeXml(value)}</text></g>`;
  }).join("\n");
}

function createContributionSvg(data, colors) {
  const width = 1180;
  const height = 300;
  const cell = 12;
  const gap = 4;
  const step = cell + gap;
  const weekCount = Math.max(...data.days.map((day) => Math.floor(differenceInDays(day.date, data.days[0].date) / 7))) + 1;
  const gridWidth = (weekCount - 1) * step + cell;
  const startX = Math.round((width - gridWidth) / 2);
  const startY = 94;
  const cells = data.days.map((day) => {
    const dayOffset = differenceInDays(day.date, data.days[0].date);
    const week = Math.floor(dayOffset / 7);
    const weekday = utcDate(day.date).getUTCDay();
    const x = startX + week * step;
    const y = startY + weekday * step;
    const delay = (0.12 + week * 0.025 + weekday * 0.004).toFixed(3);
    const label = `${day.count} contribution${day.count === 1 ? "" : "s"} on ${day.date}`;
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${colors.levels[day.level]}" class="contribution-cell" style="animation-delay:${delay}s"><title>${escapeXml(label)}</title></rect>`;
  }).join("\n");
  const rangeLabel = `${formatRangeDate(data.range.from)} — ${formatRangeDate(data.range.to)}`;
  const description = `${data.stats.total} public contributions, ${data.stats.currentStreak}-day current streak, and ${data.stats.longestStreak}-day longest streak.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(data.username)} public GitHub build activity</title>
<desc id="description">${escapeXml(description)}</desc>
<defs>
  <linearGradient id="activity-background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.backgroundStart}"/><stop offset="1" stop-color="${colors.backgroundEnd}"/></linearGradient>
  <linearGradient id="activity-border" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${colors.border}" stop-opacity="0.34"/><stop offset="0.5" stop-color="${colors.accent}"/><stop offset="1" stop-color="${colors.border}" stop-opacity="0.34"/></linearGradient>
  <pattern id="activity-scanlines" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="${colors.accent}" opacity="0.035"/></pattern>
  <style>
    .mono, .axis, .stat-label, .stat-value { font-family: 'Courier New', Consolas, monospace; }
    .command { font-size: 12px; fill: ${colors.muted}; }
    .section { font-size: 11px; letter-spacing: 1.8px; fill: ${colors.accent}; font-weight: 700; }
    .axis { font-size: 10px; fill: ${colors.muted}; }
    .stat-label { font-size: 9px; letter-spacing: 1px; fill: ${colors.muted}; }
    .stat-value { font-size: 13px; fill: ${colors.primary}; font-weight: 700; }
    .contribution-cell { transform-box: fill-box; transform-origin: center; animation: cell-in .42s cubic-bezier(.2,.8,.2,1) both; }
    @keyframes cell-in { from { opacity: .18; transform: scale(.45); } to { opacity: 1; transform: scale(1); } }
    @media (prefers-reduced-motion: reduce) { .contribution-cell { animation: none; } }
  </style>
</defs>
<rect width="${width}" height="${height}" rx="18" fill="url(#activity-background)"/>
<rect width="${width}" height="${height}" rx="18" fill="url(#activity-scanlines)"/>
<rect x="3" y="3" width="1174" height="34" rx="16" fill="${colors.panel}" fill-opacity="0.84"/>
<circle cx="24" cy="20" r="5" fill="#EF4444"/><circle cx="42" cy="20" r="5" fill="#F59E0B"/><circle cx="60" cy="20" r="5" fill="${colors.accent}"/>
<text x="590" y="25" text-anchor="middle" class="mono command">${escapeXml(data.username)}@github ~ % ./contributions --year</text>
<text x="28" y="65" class="mono section">PUBLIC.BUILD.LOG / LAST 12 MONTHS</text>
<text x="1152" y="65" text-anchor="end" class="mono axis">${escapeXml(rangeLabel)}</text>
${monthLabels(data.days, startX, step)}
<text x="${startX - 18}" y="119" text-anchor="end" class="axis">Mon</text><text x="${startX - 18}" y="151" text-anchor="end" class="axis">Wed</text><text x="${startX - 18}" y="183" text-anchor="end" class="axis">Fri</text>
${cells}
${renderStatCards(data, colors)}
<rect x="3" y="3" width="1174" height="294" rx="16" fill="none" stroke="url(#activity-border)" stroke-width="2" opacity="0.78"/>
</svg>`;
}

async function cleanOldAssets(outputDirectory, currentFiles) {
  const entries = await readdir(outputDirectory).catch(() => []);
  const generatedPattern = /^(?:contribution-console-[a-f0-9]{8}-(?:dark|light)\.svg|contributions-[a-f0-9]{8}\.json)$/;
  await Promise.all(entries
    .filter((entry) => generatedPattern.test(entry) && !currentFiles.includes(entry))
    .map((entry) => unlink(resolve(outputDirectory, entry))));
}

export async function generateContributionAssets({ config, outputDirectory, data }) {
  const contributionData = data || await fetchContributionData(config.profile.username);
  const version = createHash("sha256")
    .update(GENERATOR_VERSION)
    .update(config.appearance.palette)
    .update(JSON.stringify(contributionData))
    .digest("hex")
    .slice(0, 8);
  const assets = {
    dark: `contribution-console-${version}-dark.svg`,
    light: `contribution-console-${version}-light.svg`,
    data: `contributions-${version}.json`
  };
  const palette = themes[config.appearance.palette];

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, assets.dark), createContributionSvg(contributionData, palette.dark)),
    writeFile(resolve(outputDirectory, assets.light), createContributionSvg(contributionData, palette.light)),
    writeFile(resolve(outputDirectory, assets.data), `${JSON.stringify(contributionData, null, 2)}\n`)
  ]);
  await cleanOldAssets(outputDirectory, Object.values(assets));

  const manifest = {
    generator: GENERATOR_VERSION,
    version,
    username: contributionData.username,
    range: contributionData.range,
    stats: contributionData.stats,
    assets
  };
  await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
