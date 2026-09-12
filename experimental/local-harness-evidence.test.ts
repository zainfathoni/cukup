import { describe, expect, test } from 'bun:test'
import fixtures from './fixtures/local-harness-evidence.json'
import {
	LOCAL_PROTOCOL,
	LOCAL_PROTOCOL_VERSION,
	negotiateVersion,
	type ConformanceResult,
	validateConformanceDeliveries,
} from './local-harness-evidence.ts'

type FixtureDelivery = {
	protocol_version?: number
	evidence: unknown[]
}

describe('experimental local Harness evidence contract', () => {
	test('negotiates the greatest shared version and rejects malformed or unsupported offers', () => {
		expect(negotiateVersion([3, 1, 2], [1, 2])).toBe(2)
		expect(negotiateVersion([2], [1])).toBeUndefined()
		expect(negotiateVersion([])).toBeUndefined()
		expect(negotiateVersion([1, 1])).toBeUndefined()
	})

	test('returns fixed envelope-level outcomes for malformed supported envelopes', () => {
		const common = {
			protocol: LOCAL_PROTOCOL,
			protocol_version: LOCAL_PROTOCOL_VERSION,
			collector_instance_id: fixtures.collector_instance_id,
			capabilities: ['engagement.submission'],
		}
		expect(
			validateConformanceDeliveries(
				[
					{ ...common, evidence: null },
					{ ...common, evidence: [], unexpected: 'not reflected' },
					{ ...common, capabilities: ['recovery.engagement.submission'], evidence: [] },
				],
				fixtures.received_at,
			),
		).toEqual([
			{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' },
			{ scope: 'envelope', status: 'rejected', reason: 'unknown_field' },
			{ scope: 'envelope', status: 'rejected', reason: 'invalid_envelope' },
		])
	})

	test('rejects an unsupported version without reading evidence identities', () => {
		const unsupported = {
			protocol: LOCAL_PROTOCOL,
			protocol_version: 2,
			collector_instance_id: fixtures.collector_instance_id,
			capabilities: ['engagement.submission'],
			get evidence(): never {
				throw new Error('unsupported evidence was inspected')
			},
		}
		expect(validateConformanceDeliveries([unsupported], fixtures.received_at)).toEqual([
			{ scope: 'envelope', status: 'unsupported_version', reason: 'unsupported_version' },
		])
	})

	for (const fixture of fixtures.cases) {
		test(fixture.name, () => {
			const deliveries = fixture.deliveries.map((delivery: FixtureDelivery) => ({
				protocol: LOCAL_PROTOCOL,
				protocol_version: delivery.protocol_version ?? LOCAL_PROTOCOL_VERSION,
				collector_instance_id: fixtures.collector_instance_id,
				capabilities: fixture.capabilities,
				evidence: delivery.evidence,
			}))
			expect(validateConformanceDeliveries(deliveries, fixtures.received_at)).toEqual(
				fixture.expected as ConformanceResult[],
			)
		})
	}

	test('fixtures remain credential-free and contain no duration or cloud event construction', () => {
		const serialized = JSON.stringify(fixtures).toLowerCase()
		for (const prohibited of [
			'authorization',
			'bearer',
			'password',
			'source_sequence',
			'monotonic_duration_ms',
			'agent.start',
			'agent.end',
		]) {
			expect(serialized).not.toContain(prohibited)
		}
	})
})
