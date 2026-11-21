# Storyboard: Cukup motion explainer

Generated from [`src/scenes.js`](src/scenes.js). Edit that file. Then, from the repository root, run `scripts/voice.ts`, `scripts/docs.ts`, and `scripts/render.ts` under `media/motion-explainer/`, in that order. Speech durations change the timeline, so the voice comes first.

- **Audience:** Developers and technical leads who use AI coding agents, and people who care about them. They may never install Cukup.
- **The one idea to remember:** AI can do more work. People still decide what is enough.
- **Format:** 1920 × 1080, 30 fps, 98.9 s. A synthetic voice narrates every line, and every line is also on screen, so the story works without sound.
- **Kinds:** *Conceptual* scenes illustrate ideas. Cukup does not count, detect, or show them. *Product* scenes show the current Working Time rule and the real Today card, with synthetic data. *Title* scenes are words only.

Review the whole sequence in the [contact sheet](contact-sheet.png) before rendering.

## Scenes

| # | Scene | Time | Duration | Kind | Purpose | On-screen copy | Action | Transition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A shared concern | 0:00.0–0:08.0 | 8.0 s | Conceptual illustration | Start with an experience the viewer already knows. | “AI was supposed to save us time.”<br>“So why can coding with it still feel so tiring?” | Calm paper. A person node sends a prompt card along a connector to an agent node. The card enters the agent, and the agent starts to work. | The same agent node starts to send out result cards. |
| 2 | Output multiplies | 0:08.0–0:14.9 | 6.9 s | Conceptual illustration | Show that generation is fast and parallel. | “An agent can write code in minutes.”<br>“It can run many tasks at once.” | Result cards leave the agent along connectors and fill a grid. Two more agents branch from the first one. Each sends more cards. Every connector stays on its agent and its card. | The connectors to the agents fade after each card arrives. The cards stay in place. |
| 3 | Attention stays the same size | 0:14.9–0:23.6 | 8.7 s | Conceptual illustration | Show the choices and review that remain after generation. | “Each result still asks something of a person.”<br>“More output does not give us more attention.” | A question tag grows under each card: “Correct?”, “Safe?”, “Reversible?”. A connector runs from each tag to the person. A dashed ring around the person marks their attention. The ring does not grow. More cards arrive behind the grid. | The tags stay attached to their cards when the next scene sorts them. |
| 4 | Delegate, keep judgment | 0:23.6–0:36.5 | 12.9 s | Conceptual illustration | Separate the work AI can help with from the judgment that stays human. | “What can we hand off? What must stay ours?”<br>“Let AI help with drafts, tests, and ideas.”<br>“Keep the judgment: what matters, what is good enough, and who owns it.” | A divider appears. The question tags move to the person’s side, under “Stays with you”. The result cards stay with the agents, under “AI can help”. Each card keeps its connector to its own tag, so the work and its judgment stay linked. | The load returns: the agents send more cards toward the edges. |
| 5 | Self-compassion | 0:36.5–0:56.5 | 19.9 s | Conceptual illustration | Offer a kinder response to overload than pushing harder. | “When there is always more, it is easy to push harder.”<br>“Notice it: “I am tired, and there is a lot to review.””<br>“Remember: struggling is not a private failure. Many people feel this.”<br>“Be kind: choose a limit, as you would for a friend.” | More cards crowd in. Then every card, tag, and agent drifts outward and fades. The person moves to the center, and their ring becomes a soft solid circle. Three labels grow from the person on short connectors: Notice, Remember, Be kind. The scene holds on space. | The three labels return into the person. The person moves aside for the name. |
| 6 | Cukup means enough | 0:56.5–1:02.4 | 5.9 s | Title | Introduce the name and why the tool exists. | “Tools that help us do more need a partner that helps us pause.” | The wordmark “Cukup” writes in beside the person, with an “enough” tag and a pronunciation line. | The wordmark moves to the top-right corner and stays as a small label. |
| 7 | One prompt to pause | 1:02.4–1:25.0 | 22.7 s | Product behavior · synthetic data | Show the verified Working Time rule and view, briefly and accurately. | “Cukup counts each Amp turn, plus 15 minutes after it.”<br>“Across this synthetic day, that gives 8h 7m. The target is 8h 0m.”<br>“It is an estimate, not measured attention.”<br>“It is one prompt to ask: is this enough for today?”<br>“Cukup does not decide. You do.” | Three synthetic Amp turns draw on a 09:00–12:00 axis. Each grows a 15-minute extension. The bars drop into one Working Time row and merge. A note says the overlap counts once: 1h 22m. The axis zooms out to the full synthetic day, and the rest of the turns join the row. A connector carries the day total to the real Today card: 8h 7m, OVER, 7m over target. Last, a conceptual “Next task” card arrives at the person, and the person moves it to a “Tomorrow · your choice” slot. The chip changes to “Real Cukup view + conceptual choice”. | Everything but the person clears. |
| 8 | Invitation | 1:25.0–1:38.9 | 13.9 s | Title | Leave one line to remember and an accurate destination. | “Let AI help you do the work.”<br>“Keep the decision to say: cukup.” | The closing line appears in large type. Then the end card shows cukup.dev and the current status: open source, Amp only, and one owner per installation. | Hold on the end card, which is also the poster. |

End card: **cukup.dev** · Read why Cukup exists, and what it can and cannot tell you. · Open source · Amp only · One owner per install

## What is conceptual, and what is product behavior?

| Element | Kind | Source |
| --- | --- | --- |
| Person, agents, result cards, question tags | Conceptual | Invented for the story. Cukup does not see prompts, results, or reviews. |
| Attention ring | Conceptual | A metaphor. Nothing measures attention. |
| “AI can help” and “Stays with you” sort | Conceptual | A human practice. Cukup has no delegation feature. |
| Notice, Remember, Be kind | Conceptual | Self-compassion in everyday words. Not a feature, not therapy. |
| Turn bars, 15-minute extension, union row, 1h 22m | Product rule | [`service/aggregation.ts`](../../service/aggregation.ts), the same example as the landing page. |
| Full-day row and 8h 7m | Product rule | Synthetic events in [`product/synthetic-day.ts`](product/synthetic-day.ts), computed by the service code. |
| Today card: 8h 7m, OVER, 7m over target, target 8h 0m | Product view | A screenshot of the real renderer and CSS, from [`scripts/prepare.ts`](scripts/prepare.ts). |
| “Next task” card moved to “Tomorrow” | Conceptual | The person decides. Cukup has no button that stops agents, approves work, or enforces limits. |

## Factual limits kept in the copy

- Working Time is an estimate from Amp turns. The video says it is not measured attention.
- The video does not treat agent runtime as human effort. Parallel turns count once.
- The video claims no change in quality, productivity, stress, burnout, or wellbeing, and shows no testimonials.
- Status: open source, Amp only, and one owner per installation. There is no public signup. Only Zain's own installation has been verified for self-hosting.
- The close sends people to cukup.dev to read. It does not offer access.
