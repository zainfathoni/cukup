# Evidence: Cukup motion explainer

## Export

| Property | Value |
| --- | --- |
| File | [`cukup-explainer.mp4`](cukup-explainer.mp4) |
| Codec | H.264, yuv420p, `+faststart` |
| Dimensions | 1920 × 1080 |
| Frame rate | 30 fps, 2967 frames |
| Duration | 98.9 s |
| Size | 6.05 MiB |
| Audio | AAC, 48 kHz, mono, 128 kb/s, 98.9 s. Narration only. |
| Poster | [`poster.png`](poster.png), 1920 × 1080, the last frame |

The open-source update changes the end-card status. The new render keeps all 2967 frames and the same audio stream. I checked the poster and the decoded end card at 98.5 s for legibility. The method and findings below document the original cut.

The duration is 98.9 s, not 60–90 s. Each caption line needs 0.3 s per word, plus 1 s. Narration added 5 s: two lines needed more time for speech, and the spoken end card needed more. The product scene also needs time to show how the rule works. Cutting to 90 s would drop lines or crowd them. The scene file can make that trade if the owner prefers a shorter cut.

## Method

I inspected frames decoded from the final MP4, not source renders:

- Nine sheets at 2 fps: 198 frames, the full video.
- Ten frames per second across ±0.5 s of each of the seven scene boundaries.
- Full-resolution frames of the Today card and the end card.
- An ffmpeg `scene` filter with a threshold of 0.12. It found no abrupt change. The video has no hard cuts, so any hit would have been a jump.

Frame inspection stands in for real-time viewing. Nobody watched the video at speed on a separate display.

## Findings fixed before the final render

Earlier renders had these faults. The final render has none of them.

| Fault | Fix |
| --- | --- |
| Agent-to-card connectors stayed behind earlier cards and looked like links between cards. | Each connector fades as its card lands. |
| After the Working Time panel faded, union bars stayed on the close scene. A child with `visibility: visible` showed through its hidden parent. | Hidden nodes use `display: none`. |
| The longest caption wrapped out of its box. | Each caption shrinks to fit one line, down to 40 px. |
| “Overlap counts once” and “1h 22m” were crowded or clipped. | The track is shorter and the axis is lower. |
| “1h 22m” stayed while the full-day bars grew. | It leaves before the new bars grow. “8h 7m” appears when they are complete. |
| New cards and pills appeared on top of their source nodes. | The person and agents are drawn above what they send. |
| The wordmark wrote over the moving person and then crossed the arriving panel. | The wordmark waits for the person and reaches the corner before the panel arrives. |
| Crowding cards overlapped the “AI can help” heading. | The divider and headings leave as the crowd arrives. |
| The caption box was empty for about 0.3 s between lines. | A line holds until the next starts. |

## Pacing and legibility

- `docs.ts` checks that each line holds for at least 0.3 s per word, plus 1 s. All 21 lines pass. The shortest hold is 3.1 s.
- Captions are 45–50 px at 1080p. Stage labels are 25–42 px. The closing lines are 84 px, and the URL is 132 px.
- The Today card is 720 px wide. Its figure, “8h 7m”, is about 60 px high. Its target line is about 17 px. The caption says the same numbers: “8h 7m” and “8h 0m”.
- The compassion scene resolves density into space. Only the person remains, with a slowly breathing circle and 1.3 s without a new line.

## Continuity

- Connectors are recomputed each frame from their two nodes. No frame showed a detached end.
- Each card keeps its connector to its own question tag while the tags move to “Stays with you”.
- The prompt card travels along its connector into the agent. Cards leave agents. Pills grow from the person and return into the person.
- The morning union bars keep their identity through the zoom to the full day.
- A connector carries the day total to the Today card.

## Numbers

`prepare.ts` computes every number with the service code, from synthetic events in `product/synthetic-day.ts`. It also fails if the rendered card disagrees with the data.

| Value | Source | Shown |
| --- | --- | --- |
| Morning turns: 09:10–09:25, 09:32–09:50, 10:40–10:52 | Same example as the landing page | Turn rows |
| Counted until 09:40, 10:05, and 11:07 | `buildSessionIntervals`: end + 15 min | Striped extensions |
| Morning Working Time: 09:10–10:05 and 10:40–11:07, 82 min | `buildGlobalIntervals` | “1h 22m” |
| Full day: 7 union intervals, 487 min | Same, including a parallel turn and a turn with no end | “8h 7m” |
| Today: OVER, 487 of 480 min, 7 min over | `buildDashboardReport` → real `renderDashboardDocument` | The Today card |

The synthetic day is Tuesday 2026-09-15 in Asia/Jakarta, with the weekday target of 8h 0m.

## Claims

- `docs.ts` checks that the copy does not invite people to sign up or make unsupported claims about what Cukup measures or improves.
- The kind chip labels every conceptual scene. Product scenes say “synthetic data”. The “Next task” card arrives labelled “Your choice · conceptual”, and lands in a “Tomorrow · your choice” slot. From then on the chip reads “Real Cukup view + conceptual choice”.
- The video shows no Cukup control that stops agents, approves work, or enforces limits. The person moves the next task.
- The end card says Cukup is open source and supports Amp only and one owner per installation. Only Zain's own installation has been verified for self-hosting.

## Narration

| Check | Result |
| --- | --- |
| Voice | Kokoro-82M v1.0, voice `af_heart`, speed 0.94, synthesized locally |
| Script | Each spoken line is its caption line. Only the spoken forms of “8h 7m”, “8h 0m”, and “cukup.dev” differ. One comma was added (“write code, in minutes”) so that “in” stays audible. |
| “Cukup” | Spoken as /tʃˈuːkʊp/ (“CHOO-koop”), not the English “kyoo-kup”. `voice.py` fails if it cannot make that replacement. |
| Loudness | −16.3 LUFS integrated, 4.1 LU range, −1.4 dBTP true peak |
| Timing | `mix.ts` fails if any clip runs past its line or overlaps the next clip. Each clip starts 0.2 s after its line appears. |
| Content and sync | Whisper `medium.en` transcribed the MP4's audio inside each caption's own start and end time. All 22 windows contain their full line. Whisper hears “Cukup” as “Chukup”, the intended sound. |

The first mix check found a real fault: `small.en` and `medium.en` both heard “write code a minutes”. A comma in the spoken form fixed it. `small.en` also misheard “Tools” and “Let AI” in the mix. `medium.en` heard both clips correctly, alone and in the mix, so those were transcription errors.

## Limits

- Nobody listened to the narration. I checked it by transcription, loudness, and timing, not by ear. Tone, warmth, and naturalness need a human review.
- The voice is synthetic. It is not a person's voice and does not claim to be.
- No music or sound effects.
- The poster is the static alternative. The transcript is the text equivalent. The website player, controls, and reduced-motion behavior belong to the later embedding work.
- The Today card uses the dashboard's system font stack, as resolved on the render machine. Other machines can render the card with other fonts.
- The small brand tag in the corner is about 14 px high. It is decorative. The name is also in the brand text and the closing scenes.
- Only the light color scheme is rendered.
- Nobody reviewed the video with a screen reader or on a mobile device.
- The owner did not approve the storyboard before production. This run was not interactive, so the storyboard and contact sheet are delivered with the video for review.
