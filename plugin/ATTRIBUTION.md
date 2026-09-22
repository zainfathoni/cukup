# Attribution policy

Amp owns project selection. Cukup must not guess a project from a directory, package name, or Git remote. Unassigned work is preferable to false attribution.

Fleet owns physical Machine Labels. Bind a machine credential to its canonical Fleet name, not a convenient display alias.

Attribution changes apply to future evidence. A rename or credential rotation must not silently rewrite accepted history. See [ADR 0005](../docs/adr/0005-derive-attribution-from-amp-project.md) for the decision.

For implementation, read [project resolution](project.ts), [Amp observation](legacy-amp-adapter.ts), and [schema negotiation](sync.ts). The [future attribution design](../docs/adr/0007-generic-harness-evidence-boundary.md) does not change deployed v1/v2 contracts.
