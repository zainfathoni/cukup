#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_root
readonly workflow="$project_root/.github/workflows/deploy-service.yml"

assert_contains() {
	local expected="$1"
	grep -Fq -- "$expected" "$workflow" || {
		printf 'deployment workflow contract is missing: %s\n' "$expected" >&2
		exit 1
	}
}

# Automatic deployment is admitted only from the successful push publication
# event, while manual preflight/deploy inputs retain their existing path.
assert_contains 'workflow_dispatch:'
assert_contains 'workflow_run:'
assert_contains '- Publish service image'
assert_contains '- completed'
assert_contains "github.event_name == 'workflow_dispatch' ||"
assert_contains "(github.event_name == 'workflow_run' &&"
assert_contains "github.event.workflow_run.event == 'push' &&"
assert_contains "github.event.workflow_run.head_branch == 'main' &&"
assert_contains "github.event.workflow_run.conclusion == 'success')"

# The automatic path deploys exactly the upstream publication SHA and cannot
# inherit a manual operation. Both values remain input-driven for dispatches.
assert_contains "CUKUP_REVISION: \${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.revision }}"
assert_contains "CUKUP_OPERATION: \${{ github.event_name == 'workflow_run' && 'deploy' || inputs.operation }}"
# shellcheck disable=SC2016 # GitHub expression is matched literally.
assert_contains 'ref: ${{ env.CUKUP_REVISION }}'
# shellcheck disable=SC2016 # Shell variable is matched literally.
assert_contains 'run: scripts/deploy-service "$CUKUP_OPERATION"'

# Existing production safety boundaries must remain attached to the admitted job.
assert_contains 'group: cukup-production'
assert_contains 'cancel-in-progress: false'
assert_contains 'environment: production'

printf 'deployment workflow trigger regression checks passed\n'
