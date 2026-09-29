# Evidence: Cukup motion explainer

## Export

| Property | Value |
| --- | --- |
| File | [`cukup-explainer.mp4`](cukup-explainer.mp4) |
| Codec | H.264, yuv420p, `+faststart` |
| Dimensions | 1920 × 1080 |
| Frame rate | 30 fps, 2817 frames |
| Duration | 93.9 s |
| Size | 4.95 MiB |
| Audio | None. One video stream. |
| Poster | [`poster.png`](poster.png), 1920 × 1080, the last frame |

`scripts/inspect.ts` reported these values with ffprobe from the final file.

The duration is 93.9 s, not 60–90 s. Each caption line needs 0.3 s per word, plus 1 s. The product scene also needs time to show how the rule works. Cutting to 90 s would drop a caption line or crowd the reading time. The scene file can make that trade if the owner prefers a shorter cut.

## Method

I inspected frames decoded from the final MP4, not source renders:

- Eight sheets at 2 fps: 188 frames, the full video.
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

- `docs.ts` checks that each line holds for at least 0.3 s per word, plus 1 s. All 22 lines pass. The shortest hold is 3.1 s.
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

- `docs.ts` rejects signup, download, install, clone, self-host, and “try it” language. It also rejects claims that Cukup measures attention, productivity, wellbeing, or quality, reduces stress or burnout, or is open source now.
- The kind chip labels every conceptual scene. Product scenes say “synthetic data”. The “Next task” card is labelled “Your choice · conceptual”.
- The video shows no Cukup control that stops agents, approves work, or enforces limits. The person moves the next task.
- Status matches today: cukup.dev serves the public landing page, the dashboard is personal, support is Amp only, and the open-source release is in preparation. The repository is private.

## Limits

- The video has no audio. The captions file repeats the on-screen text for players and screen readers. It is not a narration track.
- The poster is the static alternative. The transcript is the text equivalent. The website player, controls, and reduced-motion behavior belong to the later embedding work.
- The Today card uses the dashboard's system font stack, as resolved on the render machine. Other machines can render the card with other fonts.
- The small brand tag in the corner is about 14 px high. It is decorative. The name is also in the brand text and the closing scenes.
- Only the light color scheme is rendered.
- Nobody reviewed the video with a screen reader or on a mobile device.
- The owner did not approve the storyboard before production. This run was not interactive, so the storyboard and contact sheet are delivered with the video for review.
