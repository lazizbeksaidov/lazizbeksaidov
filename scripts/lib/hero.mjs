import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { assertInk } from "./raster-check.mjs";
import { resolveTheme } from "./theme.mjs";
import { advance, fitText, keyColumnWidth } from "./type.mjs";
import { clamp, escapeXml } from "./xml.mjs";

const GENERATOR_VERSION = "builder-console-v4";

// Terminal cells are taller than they are wide. Every portrait dimension is
// derived from this ratio so the sampled grid matches the rendered grid.
// v3 hardcoded 96x64, which stretched a square source vertically by ~14%.
const CELL_ASPECT = 1.62;

const GLYPHS = " .:-=+*#%@";

// Density is carried by opacity as well as glyph choice. Glyph alone is not
// enough: at real render size the two most-used glyphs differ by well under a
// just-noticeable step, and which glyphs are heavy at all depends on the
// viewer's installed monospace face. Opacity is font-independent.
const OPACITY_STEPS = 6;
const OPACITY_FLOOR = 0.32;

const layouts = {
  desktop: {
    margin: 14,
    gap: 10,
    titlebar: 32,
    outerRadius: 16,
    panelRadius: 12,
    panelPadding: 16,
    portraitColumns: 76,
    portraitPanelWidth: 420,
    system: { fontSize: 13, lineHeight: 20.5 },
    panelTitle: 10,
    footer: 10,
    width: { minimum: 840, maximum: 1010 }
  },
  mobile: {
    margin: 18,
    gap: 14,
    titlebar: 38,
    outerRadius: 20,
    panelRadius: 12,
    panelPadding: 16,
    portraitColumns: 62,
    portraitPanelWidth: 0,
    system: { fontSize: 13, lineHeight: 21 },
    panelTitle: 11,
    footer: 10,
    width: { minimum: 480, maximum: 780 }
  }
};

/* ------------------------------------------------------------------ content */

function buildProfileLines(config) {
  const builderName = config.profile.name.split(/\s+/)[0].toLowerCase();
  const lines = [{ type: "header", value: `${builderName}@build` }];
  let section = 0;

  const push = (key, value) => lines.push({ type: "row", key, value, section });

  push("Name", config.profile.name);
  push("Role", config.profile.headline);
  push("Based", config.profile.location);
  push("Mode", config.profile.status);

  section += 1;
  lines.push({ type: "blank" }, { type: "section", value: "BUILD.FOCUS" });
  config.focus.slice(0, 4).forEach((item) => push(item.name, item.heroLabel));

  section += 1;
  lines.push({ type: "blank" }, { type: "section", value: "SELECTED.WORK" });
  config.projects.slice(0, 4).forEach((project) => push(project.name, project.heroLabel));

  if (config.links.length > 0) {
    section += 1;
    lines.push({ type: "blank" }, { type: "section", value: "CONNECT" });
    config.links.slice(0, 5).forEach((link) => push(link.label, link.value));
  }

  lines.push({ type: "blank" }, { type: "footer", value: "FROM IDEA TO WORKING PRODUCT" });
  return lines;
}

// Row text is composed once, here, so measurement and rendering can never
// disagree about how wide a row is. Keys are right-aligned within their own
// section: a global alignment would pad "Name" out to the width of "Workflow
// Automation" and push every value 15 characters right for no gain.
function composeRows(profileLines) {
  const sectionKeys = new Map();
  for (const line of profileLines) {
    if (line.type !== "row") continue;
    if (!sectionKeys.has(line.section)) sectionKeys.set(line.section, []);
    sectionKeys.get(line.section).push(line.key);
  }
  const widths = new Map([...sectionKeys].map(([index, keys]) => [index, keyColumnWidth(keys)]));

  // The value column is held by a dot leader, not by padding the key with
  // spaces. Runs of spaces collapse unless every text node carries
  // xml:space="preserve", and a leader is the honest terminal idiom anyway:
  // it walks the eye from a short key across to a distant value.
  return profileLines.map((line) => {
    if (line.type !== "row") return { ...line, text: line.value ?? "" };
    const leader = ".".repeat(widths.get(line.section) - line.key.length + 3);
    return { ...line, leader, text: `. ${line.key}: ${leader} ${line.value}` };
  });
}

/* ----------------------------------------------------------------- portrait */

async function validatePortrait(sourceBuffer, sourcePath) {
  const metadata = await sharp(sourceBuffer).metadata();
  if (!metadata.hasAlpha) {
    throw new Error(`Portrait must have a transparent background. ${sourcePath} does not contain an alpha channel.`);
  }
  const { channels } = await sharp(sourceBuffer).ensureAlpha().extractChannel("alpha").stats();
  if (channels[0].min === 255) {
    throw new Error(`Portrait must contain transparent pixels. Remove the background from ${sourcePath} before generating.`);
  }
}

async function samplePortrait(sourceBuffer, columns) {
  const trimOptions = { background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 };
  const resizeOptions = { fit: "fill", kernel: sharp.kernel.lanczos3 };

  // Measure the trimmed subject before choosing a row count, so the grid
  // matches the subject's real aspect instead of a hardcoded guess.
  const trimmed = await sharp(sourceBuffer).ensureAlpha().trim(trimOptions).png().toBuffer({ resolveWithObject: true });
  const rows = Math.max(16, Math.round((columns * trimmed.info.height) / (trimmed.info.width * CELL_ASPECT)));

  // Flatten onto mid grey, not white. The blur below mixes the flatten colour
  // into the subject's outer cells, and white would rim the whole silhouette
  // with a false highlight. Blur first at 5x the grid, then downsample: fabric
  // texture and JPEG noise would otherwise alias into the sweater and read as
  // detail that is not there.
  const [{ data: luminance }, { data: alpha }] = await Promise.all([
    sharp(trimmed.data).flatten({ background: "#808080" }).greyscale()
      .resize(columns * 5, rows * 5, resizeOptions).blur(1.4)
      .resize(columns, rows, resizeOptions).raw().toBuffer({ resolveWithObject: true }),
    sharp(trimmed.data).extractChannel("alpha")
      .resize(columns, rows, resizeOptions).raw().toBuffer({ resolveWithObject: true })
  ]);

  return { luminance, alpha, columns, rows };
}

// Tone is normalised across the SUBJECT's own range, and its polarity follows
// the theme.
//
// Both matter, and v3 got both wrong. Normalising against the full 0-255 range
// includes the flattened background, which is roughly 40% of the grid, so the
// subject occupied only part of the scale and came out flat. And ink always
// tracked darkness, which is only correct when the ink is darker than the
// ground: on the dark theme, drawing the shadows in bright cyan renders a
// photographic negative. That is why the dark hero read as a silhouette and
// the light one read as a ghost.
//
// invert=true (dark theme, light ink): ink follows brightness, so lit skin
// draws and hair falls away. invert=false (light theme, dark ink): the reverse.
const TONE_FLOOR = 0.2;
const TONE_GAMMA = 0.9;
const EDGE_GAIN = 0.7;

function buildInkField({ luminance, alpha, columns, rows }, invert) {
  const count = columns * rows;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (alpha[index] > 24) values.push(luminance[index]);
  }
  if (values.length === 0) throw new Error("Portrait sampling produced no subject pixels.");

  // Clip to the 2nd/98th percentile so one blown highlight cannot compress
  // everything else into the bottom of the scale.
  values.sort((left, right) => left - right);
  const low = values[Math.floor(values.length * 0.02)];
  const span = Math.max(1, values[Math.floor(values.length * 0.98)] - low);
  const normalise = (value) => clamp((value - low) / span, 0, 1);

  const field = new Float32Array(count);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const opacity = alpha[index] / 255;
      if (opacity <= 0.09) continue;

      const left = normalise(luminance[row * columns + Math.max(column - 1, 0)]);
      const right = normalise(luminance[row * columns + Math.min(column + 1, columns - 1)]);
      const above = normalise(luminance[Math.max(row - 1, 0) * columns + column]);
      const below = normalise(luminance[Math.min(row + 1, rows - 1) * columns + column]);
      const edge = (Math.abs(right - left) + Math.abs(below - above)) / 2;

      const tone = normalise(luminance[index]);
      const base = invert ? tone : 1 - tone;
      const curved = clamp((base - TONE_FLOOR) / (1 - TONE_FLOOR), 0, 1) ** TONE_GAMMA;
      field[index] = clamp((curved + edge * EDGE_GAIN) * opacity, 0, 1);
    }
  }
  return { field, columns, rows };
}

function createAsciiRows({ field, columns, rows }, placement) {
  const lines = [];

  for (let row = 0; row < rows; row += 1) {
    const runs = [];
    for (let column = 0; column < columns; column += 1) {
      const ink = field[row * columns + column];
      const level = ink <= 0.02 ? -1 : Math.min(OPACITY_STEPS - 1, Math.floor(ink * OPACITY_STEPS));
      const glyph = level === -1 ? " " : GLYPHS[Math.round(clamp(ink, 0, 1) * (GLYPHS.length - 1))];
      const previous = runs.at(-1);
      if (previous && previous.level === level) previous.text += glyph;
      else runs.push({ level, text: glyph });
    }

    while (runs.length > 0 && runs.at(-1).level === -1) runs.pop();
    if (runs.length === 0) continue;

    const y = (placement.y + row * placement.lineHeight).toFixed(2);
    const spans = runs.map((run) => {
      const text = escapeXml(run.text);
      if (run.level === -1) return text;
      const opacity = (OPACITY_FLOOR + ((1 - OPACITY_FLOOR) * (run.level + 1)) / OPACITY_STEPS).toFixed(3);
      return `<tspan fill-opacity="${opacity}">${text}</tspan>`;
    }).join("");

    lines.push(`<tspan x="${placement.x}" y="${y}" xml:space="preserve">${spans}</tspan>`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------- layout */

function planLayout(size, rowLines, portraitRows) {
  const layout = layouts[size];
  const { fontSize, lineHeight } = layout.system;
  const isDesktop = size === "desktop";

  const longest = rowLines.reduce((widest, line) => Math.max(widest, line.text.length), 0);
  const systemWidth = Math.ceil(longest * advance(fontSize)) + 8;
  const systemHeight = Math.ceil(rowLines.length * lineHeight) + 12;

  const infoPanelWidth = systemWidth + 2 * layout.panelPadding;
  const portraitPanelWidth = isDesktop ? layout.portraitPanelWidth : infoPanelWidth;

  const asciiInnerWidth = portraitPanelWidth - 2 * layout.panelPadding;
  const asciiAdvance = asciiInnerWidth / layout.portraitColumns;
  const asciiLineHeight = asciiAdvance * CELL_ASPECT;
  const asciiHeight = portraitRows * asciiLineHeight;

  // The portrait panel takes its natural height from the sampled grid. Any
  // slack left beside the taller info panel goes to a stack panel rather than
  // being stretched into dead space.
  const portraitPanelHeight = Math.ceil(asciiHeight) + 2 * layout.panelPadding + 6;
  const infoPanelHeight = systemHeight + 2 * layout.panelPadding;

  const width = layout.margin * 2 + infoPanelWidth + (isDesktop ? portraitPanelWidth + layout.gap : 0);

  if (width < layout.width.minimum || width > layout.width.maximum) {
    throw new Error(
      `${size} hero canvas computed at ${width}px, outside the ${layout.width.minimum}-${layout.width.maximum}px band. ` +
      `The longest console row is ${longest} characters. Shorten profile.config.json content, or move the band deliberately.`
    );
  }

  const bodyTop = layout.margin + layout.titlebar + 22;
  const bodyHeight = isDesktop
    ? Math.max(portraitPanelHeight, infoPanelHeight)
    : portraitPanelHeight + layout.gap + 22 + infoPanelHeight;
  const height = bodyTop + bodyHeight + 30 + layout.margin;

  const portraitPanel = {
    x: layout.margin,
    y: bodyTop,
    width: portraitPanelWidth,
    height: portraitPanelHeight
  };
  const infoPanel = isDesktop
    ? { x: layout.margin + portraitPanelWidth + layout.gap, y: bodyTop, width: infoPanelWidth, height: bodyHeight }
    : { x: layout.margin, y: portraitPanel.y + portraitPanel.height + layout.gap + 22, width: infoPanelWidth, height: infoPanelHeight };

  const stackTop = portraitPanel.y + portraitPanel.height + layout.gap + 18;
  const stackHeight = bodyTop + bodyHeight - stackTop;
  const stackPanel = isDesktop && stackHeight >= 64
    ? { x: portraitPanel.x, y: stackTop, width: portraitPanelWidth, height: stackHeight }
    : null;

  const slack = Math.max(0, portraitPanel.height - 2 * layout.panelPadding - asciiHeight);
  const ascii = {
    x: portraitPanel.x + layout.panelPadding,
    y: portraitPanel.y + layout.panelPadding + slack / 2 + asciiLineHeight * 0.82,
    fontSize: asciiAdvance / 0.6,
    lineHeight: asciiLineHeight,
    width: asciiInnerWidth,
    height: asciiHeight
  };
  const system = {
    x: infoPanel.x + layout.panelPadding,
    y: infoPanel.y + layout.panelPadding + fontSize,
    width: systemWidth,
    fontSize,
    lineHeight
  };

  return { layout, width, height, portraitPanel, infoPanel, stackPanel, ascii, system, isDesktop };
}

// Wrap the tech stack to the panel width. Monospace makes this exact, so the
// only failure mode left is a single token longer than the whole line, which
// would loop forever if it were not forced onto its own row.
function wrapTokens(tokens, columns) {
  const lines = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current} · ${token}` : token;
    if (candidate.length <= columns || current === "") current = candidate;
    else {
      lines.push(current);
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* --------------------------------------------------------------------- draw */

function rule(x1, x2, y, color, opacity) {
  return `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y.toFixed(1)}" ` +
    `stroke="${color}" stroke-width="1" stroke-dasharray="2 3" opacity="${opacity}"/>`;
}

function buildSystemLayer(rowLines, plan, colors) {
  const { system } = plan;
  const step = advance(system.fontSize);
  const right = system.x + system.width;
  const rows = [];

  rowLines.forEach((line, index) => {
    if (line.type === "blank") return;
    const y = system.y + index * system.lineHeight;
    const ruleY = y - system.fontSize * 0.34;

    if (line.type === "header") {
      rows.push(
        `<text x="${system.x}" y="${y.toFixed(1)}" class="system-head" fill="${colors.brand}">${escapeXml(line.value)}</text>` +
        rule(system.x + (line.value.length + 1) * step, right, ruleY, colors.textMuted, "0.5")
      );
      return;
    }

    if (line.type === "section") {
      rows.push(
        `<text x="${system.x}" y="${y.toFixed(1)}" class="system-section" fill="${colors.positive}">- ${escapeXml(line.value)}</text>` +
        rule(system.x + (line.value.length + 3) * step, right, ruleY, colors.positive, "0.42")
      );
      return;
    }

    if (line.type === "footer") {
      rows.push(`<text x="${system.x}" y="${y.toFixed(1)}" class="system-footer" fill="${colors.accentAlt}">${escapeXml(line.value)}</text>`);
      return;
    }

    rows.push(
      `<text x="${system.x}" y="${y.toFixed(1)}" class="system-row" xml:space="preserve">` +
      `<tspan fill="${colors.textMuted}">. </tspan>` +
      `<tspan class="system-key" fill="${colors.accent}">${escapeXml(line.key)}</tspan>` +
      `<tspan fill="${colors.textMuted}">: ${line.leader} </tspan>` +
      `<tspan fill="${colors.text}">${escapeXml(line.value)}</tspan></text>`
    );
  });

  return rows.join("\n");
}

function buildAmbientLayer(plan, colors) {
  const panel = plan.portraitPanel;
  const cx = panel.x + panel.width * 0.5;
  const cy = panel.y + panel.height * 0.46;
  const rx = panel.width * 0.46;
  const ry = panel.height * 0.34;
  const left = panel.x + 20;
  const right = panel.x + panel.width - 20;
  const top = panel.y + 20;
  const bottom = panel.y + panel.height - 20;
  const arm = Math.min(38, panel.width * 0.12);
  const spin = (from, to, duration, radius, dash, color, opacity) =>
    `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${radius[0].toFixed(1)}" ry="${radius[1].toFixed(1)}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="${dash}" opacity="${opacity}"><animateTransform attributeName="transform" type="rotate" from="${from} ${cx.toFixed(1)} ${cy.toFixed(1)}" to="${to} ${cx.toFixed(1)} ${cy.toFixed(1)}" dur="${duration}" repeatCount="indefinite"/></ellipse>`;

  return `<g clip-path="url(#portrait-clip)" aria-hidden="true">
  <rect x="${panel.x}" y="${panel.y}" width="${panel.width}" height="${panel.height}" fill="url(#portrait-grid)"/>
  <ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="url(#portrait-halo)"/>
  ${spin(0, 360, "42s", [rx * 0.94, ry * 0.96], "3 14", colors.accentAlt, "0.13")}
  ${spin(360, 0, "34s", [rx * 0.72, ry * 0.7], "28 24", colors.brand, "0.1")}
  <path d="M ${left} ${top} H ${left + arm} M ${left} ${top} V ${top + arm} M ${right} ${bottom} H ${right - arm} M ${right} ${bottom} V ${bottom - arm}" fill="none" stroke="${colors.accent}" stroke-width="1.2" opacity="0.22"/>
  <g fill="${colors.accent}"><circle cx="${left}" cy="${top}" r="2.2" opacity="0.42"><animate attributeName="opacity" values="0.2;0.58;0.2" dur="5.6s" repeatCount="indefinite"/></circle><circle cx="${right}" cy="${bottom}" r="2.2" opacity="0.42"><animate attributeName="opacity" values="0.58;0.2;0.58" dur="6.4s" repeatCount="indefinite"/></circle></g>
</g>`;
}

function buildStackLayer(config, plan, colors) {
  const panel = plan.stackPanel;
  if (!panel) return "";
  const fontSize = 11;
  const lineHeight = 17;
  const inner = panel.width - 2 * plan.layout.panelPadding;
  const lines = wrapTokens(config.techStack, Math.floor(inner / advance(fontSize)));
  const visible = lines.slice(0, Math.max(1, Math.floor((panel.height - 2 * plan.layout.panelPadding) / lineHeight)));
  const x = panel.x + plan.layout.panelPadding;
  const top = panel.y + plan.layout.panelPadding + fontSize;

  const body = visible.map((line, index) =>
    `<text x="${x}" y="${(top + index * lineHeight).toFixed(1)}" class="stack-row" fill="${colors.text}" xml:space="preserve">${escapeXml(line)}</text>`
  ).join("\n");

  return `<rect x="${panel.x}" y="${panel.y}" width="${panel.width}" height="${panel.height}" rx="${plan.layout.panelRadius}" fill="${colors.raised}" fill-opacity="0.38" stroke="url(#border)" stroke-opacity="0.42"/>
<text x="${panel.x + 6}" y="${(panel.y - 8).toFixed(1)}" class="panel-title">STACK / DAILY.TOOLS</text>
${body}`;
}

function createHeroSvg(config, colors, plan, ascii, rowLines) {
  const { layout, width, height, portraitPanel, infoPanel, system } = plan;
  const titlebar = { x: 3, y: 3, width: width - 6, height: layout.titlebar, radius: layout.outerRadius - 2 };
  const terminalUser = config.profile.username.slice(0, plan.isDesktop ? 22 : 16);
  const footerLabel = config.focus.slice(0, 3).map((item) => item.name.toUpperCase()).join(" / ").slice(0, 64);
  const cursorY = system.y + rowLines.length * system.lineHeight - system.fontSize;
  const firstName = config.profile.name.split(/\s+/)[0].toUpperCase();
  const midY = titlebar.y + titlebar.height / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(config.profile.name)} - ${escapeXml(config.profile.headline)}</title>
<desc id="description">A builder console showing an ASCII portrait, current focus areas, selected public work, and contact links.</desc>
<defs>
  <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.surface}"/><stop offset="1" stop-color="${colors.surfaceEnd}"/></linearGradient>
  <linearGradient id="border" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${colors.brand}"/><stop offset="0.48" stop-color="${colors.accent}"/><stop offset="1" stop-color="${colors.positive}"/></linearGradient>
  <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${colors.accent}" stop-opacity="0.4"/><stop offset="1" stop-color="${colors.brand}" stop-opacity="0"/></linearGradient>
  <radialGradient id="portrait-halo"><stop offset="0" stop-color="${colors.accent}" stop-opacity="0.13"/><stop offset="0.48" stop-color="${colors.accentAlt}" stop-opacity="0.06"/><stop offset="1" stop-color="${colors.brand}" stop-opacity="0"/></radialGradient>
  <pattern id="scanlines" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="${colors.accent}" opacity="0.05"/></pattern>
  <pattern id="portrait-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 H 0 V 40" fill="none" stroke="${colors.accentAlt}" stroke-width="0.65" opacity="0.085"/><circle cx="0" cy="0" r="1.2" fill="${colors.accent}" opacity="0.13"/></pattern>
  <clipPath id="portrait-clip"><rect x="${portraitPanel.x}" y="${portraitPanel.y}" width="${portraitPanel.width}" height="${portraitPanel.height}" rx="${layout.panelRadius}"/></clipPath>
  <clipPath id="system-clip"><rect x="${(system.x - 6).toFixed(1)}" y="${(infoPanel.y + 4).toFixed(1)}" width="${(system.width + 12).toFixed(1)}" height="${(infoPanel.height - 8).toFixed(1)}"/></clipPath>
  <style>
    .mono { font-family: 'Courier New', Consolas, monospace; }
    .ascii { font-family: 'Courier New', Consolas, monospace; font-size: ${plan.ascii.fontSize.toFixed(2)}px; fill: ${colors.asciiInk}; }
    .panel-title { font-family: 'Courier New', Consolas, monospace; font-size: ${layout.panelTitle}px; letter-spacing: 2px; fill: ${colors.accentAlt}; opacity: 0.8; }
    .terminal-label { font-family: 'Courier New', Consolas, monospace; font-size: 12px; letter-spacing: 0.5px; fill: ${colors.textMuted}; }
    .live-label { font-family: 'Courier New', Consolas, monospace; font-size: 10px; letter-spacing: 1px; fill: ${colors.positive}; }
    .system-head { font-family: 'Courier New', Consolas, monospace; font-size: ${system.fontSize + 2}px; font-weight: 700; }
    .system-section, .system-footer, .system-row { font-family: 'Courier New', Consolas, monospace; font-size: ${system.fontSize}px; }
    .stack-row { font-family: 'Courier New', Consolas, monospace; font-size: 11px; }
    .system-section, .system-key { font-weight: 700; }
    text, tspan { white-space: pre; }
  </style>
</defs>
<rect width="${width}" height="${height}" rx="${layout.outerRadius}" fill="url(#background)"/>
<rect width="${width}" height="${height}" rx="${layout.outerRadius}" fill="url(#scanlines)"/>
<rect x="${titlebar.x}" y="${titlebar.y}" width="${titlebar.width}" height="${titlebar.height}" rx="${titlebar.radius}" fill="${colors.raised}" fill-opacity="0.84"/>
<circle cx="${titlebar.x + 20}" cy="${midY}" r="5" fill="${colors.danger}"/><circle cx="${titlebar.x + 38}" cy="${midY}" r="5" fill="${colors.warn}"/><circle cx="${titlebar.x + 56}" cy="${midY}" r="5" fill="${colors.positive}"/>
<text x="${(width / 2).toFixed(1)}" y="${(midY + 4).toFixed(1)}" text-anchor="middle" class="terminal-label">${escapeXml(terminalUser)}@build ~ % ./profile</text>
${plan.isDesktop ? `<circle cx="${width - 132}" cy="${midY}" r="4" fill="${colors.positive}"><animate attributeName="opacity" values="1;0.45;1" dur="1.8s" repeatCount="indefinite"/></circle><text x="${width - 122}" y="${(midY + 4).toFixed(1)}" class="live-label">BUILDING</text>` : ""}
<rect x="${portraitPanel.x}" y="${portraitPanel.y}" width="${portraitPanel.width}" height="${portraitPanel.height}" rx="${layout.panelRadius}" fill="${colors.raised}" fill-opacity="0.38" stroke="url(#border)" stroke-opacity="0.42"/>
<rect x="${infoPanel.x}" y="${infoPanel.y}" width="${infoPanel.width}" height="${infoPanel.height}" rx="${layout.panelRadius}" fill="${colors.raised}" fill-opacity="0.42" stroke="url(#border)" stroke-opacity="0.42"/>
<text x="${portraitPanel.x + 6}" y="${(portraitPanel.y - 8).toFixed(1)}" class="panel-title">PORTRAIT / ${escapeXml(firstName)}</text>
<text x="${infoPanel.x + 6}" y="${(infoPanel.y - 8).toFixed(1)}" class="panel-title">PROFILE / PRODUCT.BUILDER</text>
${buildStackLayer(config, plan, colors)}
${buildAmbientLayer(plan, colors)}
<g clip-path="url(#portrait-clip)"><text class="ascii">${ascii}</text></g>
<g clip-path="url(#system-clip)">
${buildSystemLayer(rowLines, plan, colors)}
</g>
<rect x="${(system.x + 1).toFixed(1)}" y="${cursorY.toFixed(1)}" width="8" height="${system.fontSize + 2}" fill="${colors.accent}" opacity="0"><animate attributeName="opacity" values="0;0;1;0;1;0;1;0" keyTimes="0;0.03;0.06;0.32;0.5;0.68;0.84;1" dur="1.4s" repeatCount="indefinite"/></rect>
<text x="${(width / 2).toFixed(1)}" y="${(height - 16).toFixed(1)}" text-anchor="middle" class="mono" font-size="${layout.footer}" letter-spacing="1.5" fill="${colors.textMuted}">${escapeXml(footerLabel)}</text>
<rect x="0" y="-70" width="${width}" height="70" fill="url(#scan)" opacity="0.36" style="mix-blend-mode:${colors.scanBlend}"><animateTransform attributeName="transform" type="translate" from="0 -70" to="0 ${height + 70}" dur="7.5s" repeatCount="indefinite"/></rect>
<rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="${layout.outerRadius - 2}" fill="none" stroke="url(#border)" stroke-width="2" opacity="0.72"/>
</svg>`;
}

/* ----------------------------------------------------------------- assemble */

function inkRegions(plan, rowLines) {
  const { portraitPanel, system } = plan;
  const regions = [{
    label: "portrait",
    x: portraitPanel.x + 8,
    y: portraitPanel.y + 8,
    width: portraitPanel.width - 16,
    height: portraitPanel.height - 16
  }];

  rowLines.forEach((line, index) => {
    if (line.type === "blank") return;
    regions.push({
      label: `row:${(line.type === "row" ? line.key : line.value).trim()}`,
      x: system.x - 2,
      y: system.y + index * system.lineHeight - system.fontSize - 1,
      width: Math.min(system.width, Math.ceil(line.text.length * advance(system.fontSize)) + 4),
      height: system.fontSize + 6
    });
  });

  return regions;
}

// Hash only the fields the hero actually reads. Hashing the whole config made
// roughly three in five edits -- a tech-stack tweak, a longer project summary --
// rename all four assets and rewrite README.md for no visual change.
function heroFingerprint(config) {
  return {
    profile: {
      name: config.profile.name,
      username: config.profile.username,
      headline: config.profile.headline,
      location: config.profile.location,
      status: config.profile.status
    },
    focus: config.focus.slice(0, 4).map((item) => ({ name: item.name, heroLabel: item.heroLabel })),
    projects: config.projects.slice(0, 4).map((item) => ({ name: item.name, heroLabel: item.heroLabel })),
    links: config.links.slice(0, 5).map((item) => ({ label: item.label, value: item.value })),
    palette: config.appearance.palette
  };
}

async function cleanOldAssets(outputDirectory, currentFiles) {
  const entries = await readdir(outputDirectory).catch(() => []);
  const generatedPattern = /^agent-console-[a-f0-9]{8}-(?:mobile-)?(?:dark|light)\.svg$/;
  await Promise.all(entries
    .filter((entry) => generatedPattern.test(entry) && !currentFiles.includes(entry))
    .map((entry) => unlink(resolve(outputDirectory, entry))));
}

export async function generateHeroAssets({ config, sourcePath, outputDirectory, verify = true }) {
  const sourceBuffer = await readFile(sourcePath);
  await validatePortrait(sourceBuffer, sourcePath);

  const version = createHash("sha256")
    .update(GENERATOR_VERSION)
    .update(JSON.stringify(heroFingerprint(config)))
    .update(sourceBuffer)
    .digest("hex")
    .slice(0, 8);

  const rowLines = composeRows(buildProfileLines(config));
  const assets = {
    desktopDark: `agent-console-${version}-dark.svg`,
    desktopLight: `agent-console-${version}-light.svg`,
    mobileDark: `agent-console-${version}-mobile-dark.svg`,
    mobileLight: `agent-console-${version}-mobile-light.svg`
  };

  const documents = {};
  let regions = [];

  for (const size of ["desktop", "mobile"]) {
    const sample = await samplePortrait(sourceBuffer, layouts[size].portraitColumns);
    const plan = planLayout(size, rowLines, sample.rows);

    for (const line of rowLines) {
      if (line.type === "blank") continue;
      fitText(line.text, plan.system.fontSize, plan.system.width, `${size} console row "${line.text.trim().slice(0, 32)}"`);
    }

    for (const mode of ["dark", "light"]) {
      const suffix = mode === "dark" ? "Dark" : "Light";
      const ascii = createAsciiRows(buildInkField(sample, mode === "dark"), plan.ascii);
      documents[`${size}${suffix}`] = createHeroSvg(config, resolveTheme(config.appearance.palette, mode), plan, ascii, rowLines);
    }
    if (size === "desktop") regions = inkRegions(plan, rowLines);
  }

  if (verify) {
    await assertInk(documents.desktopDark, regions, assets.desktopDark);
    await assertInk(documents.desktopLight, regions, assets.desktopLight);
  }

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(assets).map(([key, name]) => writeFile(resolve(outputDirectory, name), documents[key])));
  await cleanOldAssets(outputDirectory, Object.values(assets));

  const manifest = { generator: GENERATOR_VERSION, version, assets, regions };
  await writeFile(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
