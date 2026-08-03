// Monospace metrics.
//
// Every renderer in this repo sets a monospace family, so advance width is
// exactly proportional to font size and layout can be measured instead of
// guessed. The ratio below was verified against librsvg: 60 characters at
// 12px predicted 432.0px and measured 432px.
//
// Nothing here may silently truncate. fitText throws, because a row that
// overflows its panel is a layout bug that must fail the build, not a string
// that quietly loses its last eight characters.

export const MONO_ADVANCE = 0.6;

export function advance(fontSize) {
  return fontSize * MONO_ADVANCE;
}

export function measure(text, fontSize, letterSpacing = 0) {
  return text.length * (advance(fontSize) + letterSpacing);
}

export function fitText(text, fontSize, maximumWidth, label) {
  const width = measure(text, fontSize);
  if (width > maximumWidth) {
    const overflow = Math.ceil((width - maximumWidth) / advance(fontSize));
    throw new Error(
      `${label} overflows its panel by ${overflow} character${overflow === 1 ? "" : "s"} ` +
      `(${width.toFixed(1)}px of ${maximumWidth.toFixed(1)}px). Shorten it in profile.config.json.`
    );
  }
  return width;
}

// Right-align keys within their own section rather than across the whole panel.
// A global alignment would pad "Name" out to the width of "Workflow Automation"
// and push every value column 15 characters to the right for no gain.
export function keyColumnWidth(keys) {
  return keys.reduce((widest, key) => Math.max(widest, key.length), 0);
}
