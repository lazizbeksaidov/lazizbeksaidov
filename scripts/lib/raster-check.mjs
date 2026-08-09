// Rasterised ink gate.
//
// The reveal bug that shipped to production was structurally invisible to
// review: Chrome runs SMIL inside <img> on github.com, so opening the profile
// showed a fully drawn console while every non-SMIL rasteriser -- OG-image
// screenshotters, WebKit thumbnailers, anything librsvg-class -- drew an empty
// box. Structural validation passed the whole time, because the document was
// perfectly well-formed and simply had no visible content.
//
// So the gate rasterises. Each generator declares the regions that must contain
// ink; this module renders the SVG through the same sharp/librsvg path the
// project already depends on and asserts each region is actually drawn.
//
// Do not replace ink coverage with standard deviation. Blanking a single row
// leaves whole-panel deviation essentially unchanged, so a deviation check
// would pass a document that lost most of its text.

import sharp from "sharp";

// A pixel counts as ink when it departs from the region's own median by more
// than this. The median tracks the local background, so the same threshold
// works on a near-black dark panel and a near-white light one.
const INK_DELTA = 18;

// Measured floor: real content bands render at 3.6-11.8% and genuinely blank
// bands at 0.00%, so 1.5% sits with roughly 2.4x margin under the lowest
// legitimate band and far above any antialiasing noise.
//
// That margin only holds for regions whose ink is roughly constant, like text
// bands. Regions whose ink scales with the data -- the contribution heatmap,
// where a sparse-but-real year draws under 1.5% -- declare their own
// data-derived floor via region.minInk instead of inheriting this default.
const MINIMUM_INK = 0.015;

export async function inkCoverage(svg, region) {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const { data } = await sharp(png)
    .extract({
      left: Math.round(region.x),
      top: Math.round(region.y),
      width: Math.round(region.width),
      height: Math.round(region.height)
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sorted = Uint8Array.from(data).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  let inked = 0;
  for (const value of data) {
    if (Math.abs(value - median) > INK_DELTA) inked += 1;
  }
  return inked / data.length;
}

// Strip every time-based reveal so the document renders as a renderer that
// ignores animation would draw it. This is the state the bug lived in.
export function freezeAtZero(svg) {
  return svg
    .replace(/<animate\b[^>]*\/>/g, "")
    .replace(/<animateTransform\b[^>]*\/>/g, "")
    .replace(/<animate\b[\s\S]*?<\/animate>/g, "")
    .replace(/<animateTransform\b[\s\S]*?<\/animateTransform>/g, "")
    .replace(/<style>[\s\S]*?<\/style>/g, (block) => block.replace(/animation\s*:[^;}]*;?/g, ""));
}

export async function assertInk(svg, regions, assetName) {
  const problems = [];

  for (const region of regions) {
    const floor = region.minInk ?? MINIMUM_INK;
    const live = await inkCoverage(svg, region);
    const frozen = await inkCoverage(freezeAtZero(svg), region);
    const worst = Math.min(live, frozen);

    if (worst < floor) {
      const which = frozen < live ? "with animation frozen at t=0" : "as rendered";
      problems.push(
        `${assetName}: region "${region.label}" is ${(worst * 100).toFixed(2)}% ink ${which}, ` +
        `below the ${(floor * 100).toFixed(2)}% floor.`
      );
    }
  }

  if (problems.length > 0) throw new Error(`Blank render detected:\n  ${problems.join("\n  ")}`);
  return regions.length;
}
