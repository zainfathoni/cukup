# Cukup motion explainer

A silent motion explainer about human attention, delegation, self-compassion, and enough. It is a review candidate for [issue #29](https://github.com/zainfathoni/cukup/issues/29). It is not published, and it is not embedded in the website.

| File | Purpose |
| --- | --- |
| [`cukup-explainer.mp4`](cukup-explainer.mp4) | Final export. H.264, 1920 × 1080, 30 fps, no audio. |
| [`poster.png`](poster.png) | Poster and static alternative. It is the end card. |
| [`captions.en.vtt`](captions.en.vtt) | Timed cues of the on-screen text. |
| [`transcript.md`](transcript.md) | Text equivalent with visual descriptions. |
| [`storyboard.md`](storyboard.md) | Audience, idea, and scene plan. |
| [`contact-sheet.png`](contact-sheet.png) | One still per caption line, for review of the whole sequence. |
| [`evidence.md`](evidence.md) | Inspection of the rendered video, and its limits. |
| [`src/`](src) | Editable source: story, animation, and styles. |
| [`product/synthetic-day.ts`](product/synthetic-day.ts) | Synthetic events behind every number. |
| [`scripts/`](scripts) | Data preparation, document generation, and rendering. |

## How is the video made?

[`src/scenes.js`](src/scenes.js) holds the story: each scene's purpose, copy, action, transition, and timing. The storyboard, captions, transcript, contact sheet, and animation all read it.

[`src/explainer.js`](src/explainer.js) draws each frame as a pure function of time. It uses no CSS transitions, timers, or clock. Connectors are recomputed each frame from their two nodes, so they stay attached.

The service code computes every number. [`scripts/prepare.ts`](scripts/prepare.ts) runs the synthetic events through `buildDashboardReport` and writes `src/generated/data.js`. It also screenshots the Today card from the real dashboard renderer and CSS, and fails if the card disagrees with the data.

## How do I render it?

Prerequisites:

- Bun, from the repository's `package.json`.
- Chromium. Set `CHROMIUM_PATH` if `chromium` is not on `PATH`.
- Playwright, installed globally. Set `PLAYWRIGHT_MODULE` to its package directory if `playwright` is not on `PATH`. It is not a project dependency.
- ffmpeg with libx264.
- ImageMagick 7, for the contact sheet.
- The Noto Sans and Noto Sans Mono fonts. The render fails if a font is missing.

Run these commands from the repository root:

```sh
bun media/motion-explainer/scripts/prepare.ts          # numbers and the Today card
bun media/motion-explainer/scripts/docs.ts             # storyboard, captions, transcript, copy checks
bun media/motion-explainer/scripts/render.ts contact   # contact-sheet.png
bun media/motion-explainer/scripts/render.ts video     # cukup-explainer.mp4, about 5 minutes
bun media/motion-explainer/scripts/render.ts poster    # poster.png
bun media/motion-explainer/scripts/inspect.ts          # out/inspect-*.png and a frame report
```

`docs.ts` fails if a line has too little reading time (0.3 s per word, plus 1 s) or makes a forbidden claim.

To scrub the animation while you edit, serve `src/` with any static server and open `index.html?controls`. Add `&t=62` to start at 62 seconds.

## Provenance and licensing

| Asset | Source | License |
| --- | --- | --- |
| Story, copy, animation, and styles | Written for this issue | [MIT](../../LICENSE), with the repository |
| Colors, borders, and shadows | Cukup's dashboard design tokens | MIT |
| Today card image | Real Cukup renderer and CSS, with synthetic data | MIT |
| Numbers | Synthetic events, computed by the service code | MIT |
| Noto Sans, Noto Sans Mono | System fonts, rendered into the video. Not redistributed as files. | SIL Open Font License 1.1 |
| Audio | None | — |

No reference media, footage, names, paths, counts, or branding from other products is used. No personal activity data is used.

## What does the video not claim?

The video does not claim that Cukup measures attention, quality, productivity, stress, burnout, or wellbeing. It shows no testimonials. The person, agents, cards, attention ring, and “Next task” card are conceptual. Cukup does not see them, count them, or act on them. See the [storyboard](storyboard.md) for the full split.
