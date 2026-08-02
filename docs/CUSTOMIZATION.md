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

Up to four links become badges below the hero. Only include links you are comfortable making permanently public.

### Build Activity

The generator reads the public GitHub contribution calendar and creates dark/light SVGs in `assets/activity/`. The daily workflow refreshes both the contribution console and the Recent Activity list without relying on a third-party stats image service.

## Palettes

- `signal`: cyan, violet, and green on a research-console background.
- `ocean`: teal, blue, and indigo with a calmer systems feel.
- `solar`: cyan, blue, and amber with warmer technical accents.

Every palette includes separate dark and light values.

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

The content and portrait determine a new eight-character hero version. Public contribution data determines a separate activity version. Old generated assets are removed automatically, and README receives the new filenames.

Recent Activity content is preserved when the full README is regenerated.
