import type { AttributedStoredWorkEvent } from '../types.ts'
import {
	availableDashboardLabels,
	buildDashboardReport,
	parseDashboardSelection,
	type DashboardReportStore,
} from './report-builder.ts'
import type { DashboardSelection } from './report.ts'
import { renderDashboardDocument } from './render.ts'

const minute = 60_000
const now = Date.parse('2026-08-31T05:00:00.000Z')
const base = Date.parse('2026-08-31T01:00:00.000Z')
const initialSelection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }

function session(options: {
	index: number
	source: string
	project?: string
	executor: string
	start: number
	end: number
}): AttributedStoredWorkEvent[] {
	const event = (
		kind: 'agent.start' | 'agent.end',
		sequence: number,
		at: number,
	): AttributedStoredWorkEvent => ({
		schemaVersion: options.project ? 2 : 1,
		...(options.project ? { projectSlug: options.project } : {}),
		eventId: `00000000-0000-7000-8000-${String(options.index * 10 + sequence).padStart(12, '0')}`,
		sourceInstance: options.source,
		sourceSequence: sequence,
		sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(options.index).padStart(12, '0')}`,
		kind,
		occurredAt: new Date(at).toISOString(),
		occurredAtMs: at,
		receivedAt: new Date(at + minute).toISOString(),
		receivedAtMs: at + minute,
		executorLabel: options.executor,
	})
	return [
		event('agent.start', options.index * 2 - 1, options.start),
		event('agent.end', options.index * 2, options.end),
	]
}

const events = [
	...session({
		index: 1,
		source: 'source-a',
		project: 'alpha',
		executor: 'machine-a',
		start: base,
		end: base + 60 * minute,
	}),
	...session({
		index: 2,
		source: 'source-b',
		project: 'alpha',
		executor: 'amp-orb',
		start: base + 30 * minute,
		end: base + 90 * minute,
	}),
	...session({
		index: 3,
		source: 'source-c',
		project: 'beta',
		executor: 'machine-a',
		start: base + 45 * minute,
		end: base + 75 * minute,
	}),
	...session({
		index: 4,
		source: 'source-d',
		executor: 'retired-machine',
		start: base - 24 * 60 * minute,
		end: base - 24 * 60 * minute + 20 * minute,
	}),
]

const store: DashboardReportStore = {
	events: () => events.map(({ executorLabel: _, ...event }) => event),
	attributedEvents: () => events,
	targetOverrides: () => new Map(),
	listBearerMetadata: () => [
		{ executorLabel: 'machine-a', revokedAt: null },
		{ executorLabel: 'retired-machine', revokedAt: '2026-08-02T00:00:00.000Z' },
	],
	shadowDisclosures: () => ({
		delivery: { availability: 'ready', disclosures: [] },
		labels: new Map(),
	}),
}

const bundle = await Bun.build({
	entrypoints: [new URL('./client.ts', import.meta.url).pathname],
	minify: true,
	target: 'browser',
})
if (!bundle.success) throw new Error('Dashboard preview client build failed')

const client = await bundle.outputs[0]!.text()
const css = await Bun.file(new URL('./dashboard.css', import.meta.url)).text()
const labels = availableDashboardLabels(store)

function document(): string {
	return renderDashboardDocument(buildDashboardReport(store, initialSelection, now), initialSelection).replace(
		'<main>',
		'<main><div class="panel-notice stale" role="note"><strong>Interactive review fixture.</strong> This portal uses deterministic sample evidence; filters and heatmap dates recompute the timeline through the real dashboard report builder.</div>',
	)
}

Bun.serve({
	port: Number(process.env.PORT ?? 4173),
	async fetch(request) {
		const pathname = new URL(request.url).pathname
		if (pathname === '/up') return new Response('ok')
		if (pathname === '/assets/dashboard.css') {
			return new Response(css, { headers: { 'content-type': 'text/css' } })
		}
		if (pathname === '/assets/dashboard.js') {
			return new Response(client, { headers: { 'content-type': 'text/javascript' } })
		}
		if (pathname === '/dashboard/report' && request.method === 'POST') {
			const selection = parseDashboardSelection(await request.json(), labels)
			if (!selection) return new Response('Invalid dashboard selection.', { status: 400 })
			return Response.json(buildDashboardReport(store, selection, now))
		}
		return new Response(document(), { headers: { 'content-type': 'text/html' } })
	},
})
