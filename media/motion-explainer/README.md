# Cukup motion explainer

A narrated motion explainer about human attention, delegation, self-compassion, and enough. It is for [issue #29](https://github.com/zainfathoni/cukup/issues/29). The signed-out page embeds it. See the [dashboard service](../../docs/dashboard-service.md#what-does-a-signed-out-visitor-see) and the [browser evidence](../../docs/tests/landing-explainer/e2e-evidence.md).

| File | Purpose |
| --- | --- |
| [`cukup-explainer.mp4`](cukup-explainer.mp4) | Final export. H.264 1920 × 1080 at 30 fps, with AAC mono narration. |
| [`narration.m4a`](narration.m4a) | The narration mix, muxed into the video. |
| [`poster.png`](poster.png) | Poster and static alternative. It is the end card. |
| [`captions.en.vtt`](captions.en.vtt) | Captions of the narration. |
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

The narration speaks each caption line. `scripts/voice.ts` synthesizes one clip per line locally with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), through `kokoro-onnx`. Nothing is sent to a speech service. A line holds for at least its speech, plus 0.8 s. So the voice sets the pace when it needs more time than the reading rule. A line's optional `say` field sets its spoken form, for example “eight hours and seven minutes” for “8h 7m”. English rules read “Cukup” as “kyoo-kup”, so `voice.py` replaces its phonemes with the Indonesian /tʃˈuːkʊp/. `mix.ts` places each clip 0.2 s after its line appears and normalizes the mix to −16 LUFS.

The service code computes every number. [`scripts/prepare.ts`](scripts/prepare.ts) runs the synthetic events through `buildDashboardReport` and writes `src/generated/data.js`. It also screenshots the Today card from the real dashboard renderer and CSS, and fails if the card disagrees with the data.

## How do I render it?

Prerequisites:

- Bun, from the repository's `package.json`.
- Chromium. Set `CHROMIUM_PATH` if `chromium` is not on `PATH`.
- Playwright, installed globally. Set `PLAYWRIGHT_MODULE` to its package directory if `playwright` is not on `PATH`. It is not a project dependency.
- ffmpeg with libx264.
- ImageMagick 7, for the contact sheet.
- The Noto Sans and Noto Sans Mono fonts. The render fails if a font is missing.
- For narration only: Python 3.12 with `kokoro-onnx` and `soundfile`, plus the Kokoro v1.0 model files. This set-up keeps them outside the repository:

  ```sh
  mkdir -p ~/.cache/cukup-voice && cd ~/.cache/cukup-voice
  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python kokoro-onnx soundfile
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
  curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
  ```

  Set `VOICE_PYTHON` and `KOKORO_DIR` to use other locations. You need this set-up only after a copy or timing change. `narration.m4a` is committed.

Run these commands from the repository root:

```sh
bun media/motion-explainer/scripts/prepare.ts          # numbers and the Today card
bun media/motion-explainer/scripts/voice.ts            # narration clips, durations, narration.m4a
bun media/motion-explainer/scripts/docs.ts             # storyboard, captions, transcript, copy checks
bun media/motion-explainer/scripts/render.ts contact   # contact-sheet.png
bun media/motion-explainer/scripts/render.ts video     # cukup-explainer.mp4, about 5 minutes
bun media/motion-explainer/scripts/render.ts poster    # poster.png
bun media/motion-explainer/scripts/inspect.ts          # out/inspect-*.png and a frame report
bun media/motion-explainer/scripts/verify-landing.ts   # player checks against a running preview; see the file
```

Run `voice.ts` before `docs.ts` and `render.ts`, because speech durations change the timeline. `render.ts video` fails if `narration.m4a` does not match the timeline.

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
| Narration voice | Kokoro-82M v1.0, voice `af_heart`, synthesized locally | Apache License 2.0 |
| Music and effects | None | — |

No reference media, footage, names, paths, counts, or branding from other products is used. No personal activity data is used.

## What does the video not claim?

The video does not claim that Cukup measures attention, quality, productivity, stress, burnout, or wellbeing. It shows no testimonials. The person, agents, cards, attention ring, and “Next task” card are conceptual. Cukup does not see them, count them, or act on them. See the [storyboard](storyboard.md) for the full split.
