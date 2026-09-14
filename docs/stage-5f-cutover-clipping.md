# Stage 5F: internal cutover clipping

This slice adds `summarizeShadowAfterCutover` as a pure internal reporting boundary atop the Stage 5E shadow aggregation. The caller supplies one account-wide owner-approved cutover instant. The function accepts it only when it is exactly Monday 00:00 in Asia/Jakarta; it does not choose, store, configure, approve, or activate that instant. There is no production importer or authority switch.

The result retains Stage 5E's civil day/week boundaries, as-of cap, independent global unions, non-additive project and execution-site lanes, and immutable start attribution. It adds the cutover as a lower half-open reporting bound. A 15-minute Engagement Window or defensibly closed execution interval crossing the boundary contributes only its portion at or after cutover. An interval starting exactly at cutover is eligible; an interval ending at or before cutover contributes zero. Pending execution remains zero because clipping neither closes an interval nor invents an endpoint.

Clipping does not rewrite accepted evidence or derived intervals. Only the generic shadow records supplied by the caller are considered. Complete legacy v1/v2 records and summaries remain separate and unchanged; legacy grace, crash caps, and turn-based evidence never fill prospective metrics. Occurrence time remains authoritative, so an endpoint accepted after its occurrence and after the report's as-of receipt timing can revise the earlier occurrence period. `asOfMs` still caps elapsed contribution rather than reconstructing what was known then.

Focused tests cover intervals wholly before, crossing, and starting at cutover; before, straddling, and after report periods; as-of immediately before, equal to, and after cutover; late closure and receipt-time independence; pending execution; exact Jakarta Monday-midnight validation and refusals; independent global/lane unions; and equality of input, persisted shadow, legacy rows, and legacy summaries after reporting.

This boundary is in-memory only. It adds no owner workflow, setting, schema, migration, route, public summary, dashboard, target comparison, collector/outbox, OIDC/Amp-orb execution-site design, backfill, deployment, support claim, or production caller. Zero means no contributing interval in the supplied snapshot, not proof of no work or complete observation coverage.

## Publication implications

The function has no production importer and changes no runtime activation or schema. Its `service/**` paths nevertheless match the existing main-push service-publication workflow, so this slice is **not publication-neutral**: an eventual push may publish a service image and requires explicit owner approval. No push, publication, deployment, production access, or shared setting change is authorized or performed here.
