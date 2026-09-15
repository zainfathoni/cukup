import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITIES, LOCAL_PROTOCOL } from '../harness-evidence-protocol.ts'
import { ServiceStore } from '../store.ts'
import { preserveReportAsStale } from './controller.ts'
import { buildDashboardReport } from './report-builder.ts'

const now = Date.parse('2026-08-31T05:00:00.000Z')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('service source composes Stage 5M lanes and Stage 5N ready delivery with exact site labels', () => {
	const directory = mkdtempSync(join(tmpdir(), 'cukup-dashboard-shadow-'))
	directories.push(directory)
	const store = new ServiceStore(join(directory, 'service.sqlite'), {
		now: () => now,
		trusted: () => true,
	})
	try {
		for (const [index, label, state] of [
			[1, 'machine-a', 'clear'],
			[2, 'machine-b', 'blocked'],
		] as const) {
			const credential = store.issueBearer(now)
			expect(store.bindExecutorLabel(credential.tokenId, label).outcome).toBe('bound')
			const site = store.shadowExecutionSite(credential.tokenId)!
			const collector = id(index)
			expect(store.shadow.appendCoverage({
				executionSiteId: site,
				sourceSequence: 1,
				envelope: {
					protocol: LOCAL_PROTOCOL,
					protocol_version: 1,
					collector_instance_id: collector,
					capabilities: CAPABILITIES,
					fact: {
						family: 'capability_declaration',
						fact_id: id(100 + index),
						effective_at: new Date(now - 60_000).toISOString(),
					},
				},
			}, now).status).toBe('accepted')
			expect(store.synchronization.observe(credential.tokenId, {
				protocol_version: 1,
				collector_instance_id: collector,
				observation_sequence: 1,
				observed_at_ms: now,
				state,
				records: state === 'clear' ? 0 : 1,
				bytes: state === 'clear' ? 0 : 64,
				oldest_queued_at_ms: state === 'clear' ? null : now - 1_000,
			})).toEqual({ status: 'accepted' })
		}

		const source = store.shadowDisclosures({ startMs: now - 120_000, endMs: now + 1 })
		expect(source.delivery.availability).toBe('ready')
		if (source.delivery.availability !== 'ready') throw new Error('Expected ready delivery')
		expect(source.delivery.disclosures.map((lane) => [
			source.labels.get(lane.executionSiteId),
			lane.synchronization,
		])).toEqual([
			['machine-a', 'clear'],
			['machine-b', 'blocked'],
		])

		const report = buildDashboardReport(
			store,
			{ projects: [], executors: [], range: { preset: 7 } },
			now,
		)
		expect(report.shadow_disclosures.state).toBe('ready')
		if (report.shadow_disclosures.state !== 'ready') throw new Error('Expected report disclosures')
		expect(report.shadow_disclosures.data.lanes.map((lane) => [lane.label, lane.synchronization])).toEqual([
			['machine-a', 'unknown'],
			['machine-b', 'unknown'],
		])
		const stale = preserveReportAsStale(report).shadow_disclosures
		expect(stale.state).toBe('stale')
		if (stale.state !== 'stale') throw new Error('Expected stale report disclosures')
		expect(stale.data.lanes.map((lane) => lane.synchronization)).toEqual(['unknown', 'unknown'])
	} finally {
		store.close()
	}
})
