# Cukup link-preview image

The Open Graph image for cukup.dev, for [issue #32](https://github.com/zainfathoni/cukup/issues/32). Chat apps and social feeds show it when someone shares the home page. The service serves it at `/assets/og-image.png`; see [dashboard service](../../docs/dashboard-service.md#what-does-a-signed-out-visitor-see) and the [preview evidence](../../docs/tests/og-image/evidence.md).

| File | Purpose |
| --- | --- |
| [`og-image.png`](og-image.png) | The shipped image. 1200 × 630, 8-bit palette PNG. |
| [`src/index.html`](src/index.html), [`src/og-image.css`](src/og-image.css) | Editable source. |
| [`scripts/render.ts`](scripts/render.ts) | Renders the source to `og-image.png`, and writes review previews to `out/`. |

## What does the image say?

It carries the home page's headline: “AI can do more. You still decide what is enough.” It adds the Cukup wordmark, the “enough” tag, and the address. It shows no dashboard, no numbers, and no status claims. Small text does not survive a 300 px preview, so the image has none.

The alt text is `SOCIAL_IMAGE_ALT` in [`service/dashboard/social-image.ts`](../../service/dashboard/social-image.ts). Change it when you change the words or layout.

## How do I render it?

Prerequisites:

- Bun, from the repository's `package.json`.
- Chromium and a global Playwright, as for the [motion explainer](../motion-explainer/README.md#how-do-i-render-it). The script uses the same `CHROMIUM_PATH` and `PLAYWRIGHT_MODULE` settings.
- ImageMagick 7.
- The Noto Sans Black and Noto Sans Mono Bold fonts.

Run this command from the repository root:

```sh
bun media/og-image/scripts/render.ts
```

The script fails if a font is not installed or if text leaves the safe area. The safe area is 80 px from the sides and 48 px from the top and bottom. The headline must also fit the center 630 × 630 square, which some apps crop to. A re-render on the same fonts gives identical bytes.

The service checks the file at start-up. It refuses a file that is not a 1200 × 630 PNG, so the page metadata cannot state the wrong size. A change to `og-image.png` triggers a new service image through the publication path filter.

## Provenance and licensing

| Asset | Source | License |
| --- | --- | --- |
| Copy, layout, and styles | Written for this issue. The headline is the live home page's. | [MIT](../../LICENSE), with the repository |
| Colors, borders, and shadows | Cukup's dashboard design tokens, through the motion explainer's end card | MIT |
| Noto Sans Black, Noto Sans Mono Bold | System fonts, rendered into the image. Not redistributed as files. | SIL Open Font License 1.1 |

The image uses no photographs, screenshots, reference media, or other products' branding. It uses no activity data, account details, or paths.
