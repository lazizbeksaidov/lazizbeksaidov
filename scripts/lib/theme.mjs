// Single source of truth for colour across every generated asset.
//
// Tokens are named by ROLE, not by hue, because two of the three palettes are
// not the hue their old names claimed: solar's "violet" slot is amber and
// ocean's "cyan" slot is teal. Renderers must never reference a hue name.
//
// scale[] is the five-step density ramp used by the contribution heatmap.
// It is asserted monotonic with a minimum perceptual step by assertThemes(),
// which validate.mjs runs on every check.

const themes = {
  signal: {
    dark: {
      surface: "#020617",
      surfaceEnd: "#11152F",
      raised: "#07111F",
      line: "#38BDF8",
      text: "#E5E7EB",
      textMuted: "#64748B",
      accent: "#22D3EE",
      accentAlt: "#38BDF8",
      brand: "#7C3AED",
      positive: "#10B981",
      warn: "#F59E0B",
      danger: "#EF4444",
      asciiInk: "#E9F2F9",
      scanBlend: "screen",
      scale: ["#141D2E", "#0B5A75", "#0E86A6", "#25C3DD", "#8FE9F7"]
    },
    light: {
      surface: "#F8FBFF",
      surfaceEnd: "#F5F3FF",
      raised: "#FFFFFF",
      line: "#2563EB",
      text: "#172554",
      textMuted: "#5A6B87",
      accent: "#0891B2",
      accentAlt: "#2563EB",
      brand: "#6D28D9",
      positive: "#047857",
      warn: "#B45309",
      danger: "#DC2626",
      asciiInk: "#172554",
      scanBlend: "multiply",
      scale: ["#E3E9F2", "#9BD9E8", "#49AECD", "#1B7FA3", "#0A4C66"]
    }
  },
  ocean: {
    dark: {
      surface: "#02131A",
      surfaceEnd: "#111827",
      raised: "#061A22",
      line: "#38BDF8",
      text: "#E5F6F8",
      textMuted: "#6B8791",
      accent: "#2DD4BF",
      accentAlt: "#38BDF8",
      brand: "#6366F1",
      positive: "#34D399",
      warn: "#FBBF24",
      danger: "#FB7185",
      asciiInk: "#E4F7F8",
      scanBlend: "screen",
      scale: ["#13272E", "#0D5952", "#12857A", "#2FCBB6", "#93EFE0"]
    },
    light: {
      surface: "#F4FCFC",
      surfaceEnd: "#F4F7FF",
      raised: "#FFFFFF",
      line: "#0284C7",
      text: "#123047",
      textMuted: "#54707C",
      accent: "#0F766E",
      accentAlt: "#0284C7",
      brand: "#4F46E5",
      positive: "#047857",
      warn: "#B45309",
      danger: "#BE123C",
      asciiInk: "#123047",
      scanBlend: "multiply",
      scale: ["#E2EDEE", "#97DDD3", "#45B3A4", "#1A8375", "#08514A"]
    }
  },
  solar: {
    dark: {
      surface: "#090D14",
      surfaceEnd: "#1D1720",
      raised: "#10141C",
      line: "#22D3EE",
      text: "#F3F4F6",
      textMuted: "#7C8495",
      accent: "#F59E0B",
      accentAlt: "#60A5FA",
      brand: "#F59E0B",
      positive: "#34D399",
      warn: "#F59E0B",
      danger: "#FB7185",
      asciiInk: "#F7F1E6",
      scanBlend: "screen",
      scale: ["#26232A", "#7A3D0A", "#B06C0D", "#EFA31C", "#FBD888"]
    },
    light: {
      surface: "#FBFCFE",
      surfaceEnd: "#FFF8ED",
      raised: "#FFFFFF",
      line: "#2563EB",
      text: "#292524",
      textMuted: "#6B635C",
      accent: "#B45309",
      accentAlt: "#2563EB",
      brand: "#B45309",
      positive: "#047857",
      warn: "#B45309",
      danger: "#BE123C",
      asciiInk: "#292524",
      scanBlend: "multiply",
      scale: ["#EDE9E3", "#EEC677", "#DDA02F", "#A96A0C", "#6E4207"]
    }
  }
};

export const paletteNames = Object.keys(themes);

export function resolveTheme(palette, mode) {
  const entry = themes[palette];
  if (!entry) throw new Error(`Unknown palette "${palette}". Expected one of: ${paletteNames.join(", ")}.`);
  const tokens = entry[mode];
  if (!tokens) throw new Error(`Unknown mode "${mode}" for palette "${palette}".`);
  return tokens;
}

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

// The heatmap ramp is the one place where "looks fine" silently fails: adjacent
// levels that differ by less than ~1.25 in contrast are indistinguishable, so a
// four-contribution day and a nine-contribution day render as the same square.
const MINIMUM_SCALE_STEP = 1.25;

export function assertThemes() {
  const problems = [];

  for (const [palette, modes] of Object.entries(themes)) {
    for (const [mode, tokens] of Object.entries(modes)) {
      const label = `${palette}.${mode}`;

      const textContrast = contrastRatio(tokens.text, tokens.raised);
      if (textContrast < 4.5) {
        problems.push(`${label}: text on raised is ${textContrast.toFixed(2)}:1, below 4.5:1.`);
      }

      const luminances = tokens.scale.map(relativeLuminance);
      const descending = luminances[0] > luminances.at(-1);
      for (let index = 1; index < luminances.length; index += 1) {
        const previous = luminances[index - 1];
        const current = luminances[index];
        const monotonic = descending ? current < previous : current > previous;
        if (!monotonic) {
          problems.push(`${label}: scale[${index}] breaks monotonic luminance order.`);
          continue;
        }
        const step = (Math.max(previous, current) + 0.05) / (Math.min(previous, current) + 0.05);
        if (step < MINIMUM_SCALE_STEP) {
          problems.push(`${label}: scale[${index - 1}]→scale[${index}] step is ${step.toFixed(3)}, below ${MINIMUM_SCALE_STEP}.`);
        }
      }
    }
  }

  if (problems.length > 0) throw new Error(`Theme assertions failed:\n  ${problems.join("\n  ")}`);
  return Object.keys(themes).length;
}
