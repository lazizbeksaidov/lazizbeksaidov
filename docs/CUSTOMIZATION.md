# Customization

## Edit Configuration First

Most customization belongs in `profile.config.json`. The schema limits hero text lengths because SVG terminal rows cannot wrap safely.

### Profile

Use a specific headline that combines direction and evidence, such as:

- `AI Researcher & Web3 Builder`
- `Machine Learning Engineer & Open Source Maintainer`
- `Backend Engineer & Developer Tools Builder`

Avoid long skill inventories in the headline.

### Builder Console Focus

The first four `focus` items power `BUILD.FOCUS` in the terminal panel. Give each item a concise `heroLabel`; use `description` for the fuller README table. The `research.narrative` field powers the longer Product Direction section.

### Featured Projects

The first four projects appear in the hero. Up to six appear in the README table. Order them by how strongly they support your positioning, not by creation date.

`heroLabel` should describe the project's role in two to four words, for example `Web3 trust layer` or `Test recovery system`.

### Public Links

Up to five links appear twice: as a `CONNECT` section inside the hero console, and as plain text links under it. Each needs only `label`, `value`, and `url` — there is no badge image, so no logo slug or colour.

Only include links you are comfortable making permanently public. The hero is an SVG served from `raw.githubusercontent.com`, so anything in `value` is scrapeable plain text; prefer a public handle or profile URL over a personal inbox or phone number.

### Build Activity

The generator reads the public GitHub contribution calendar and creates dark/light SVGs in `assets/activity/`, at both desktop and narrow-column sizes. The daily workflow refreshes both the contribution console and the Recent Activity list without relying on a third-party stats image service.

## Palettes

- `signal`: cyan, violet, and green on a research-console background.
- `ocean`: teal, blue, and indigo with a calmer systems feel.
- `solar`: cyan, blue, and amber with warmer technical accents.

Every palette includes separate dark and light values. All of them live in one place, `scripts/lib/theme.mjs`, and are named by role (`surface`, `accent`, `positive`, `asciiInk`, …) rather than by hue — two palettes do not contain the hue their old names claimed. `npm run check` asserts every palette for text contrast and for a monotonic heatmap ramp with a minimum perceptual step, so an unreadable palette fails the build instead of shipping.

## Portrait Guidance

Best results come from:

- A transparent PNG.
- Head-to-torso framing.
- Clear facial lighting.
- Visible separation between hair, face, and clothing.
- Minimal translucent edges around the cutout.

Do not add a decorative background before generation. The console adds its own restrained ambient layer.

## Updating Later

Edit `profile.config.json`, then regenerate with the same private source file:

```bash
npm run generate -- --source /absolute/path/to/portrait.png
```

The hero version hashes only the fields the hero actually draws, so editing a project summary or the tech stack no longer renames all four hero assets. Public contribution data determines a separate activity version, excluding the current streak, which changes with the wall clock and would otherwise produce a new filename every UTC midnight for identical input.

Old generated assets are removed automatically, and README receives the new filenames.

Generation refuses to write an asset that would render blank: each generator declares the regions that must contain ink, and those regions are rasterised and measured both as drawn and with all animation stripped. `npm run check` repeats the same measurement on the committed files.

Recent Activity content is preserved when the full README is regenerated.
