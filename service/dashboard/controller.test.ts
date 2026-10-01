import { describe, expect, test } from 'bun:test'
import { DashboardController, preserveReportAsStale, type DashboardClock, type DashboardView, type DashboardVisibility } from './controller.ts'
import { MockDashboardTransport, mockDashboardReport } from './fixture.ts'
import type { DashboardReport, DashboardSelection, DashboardTransport } from './report.ts'

const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }

class FakeView implements DashboardView {
	renders: Array<{
		report: DashboardReport
		selection: DashboardSelection
		refreshing: boolean
		filtersDisabled: boolean
	}> = []
	announcements: string[] = []
	render(
		report: DashboardReport,
		current: DashboardSelection,
		refreshing: boolean,
		filtersDisabled: boolean,
	): void {
		this.renders.push({
			report: structuredClone(report),
			selection: structuredClone(current),
			refreshing,
			filtersDisabled,
		})
	}
	announce(message: string): void { this.announcements.push(message) }
}

class FakeClock implements DashboardClock {
	callbacks = new Map<number, () => void>()
	delays: number[] = []
	next = 1
	setTimeout(callback: () => void, delayMs: number): number {
		const handle = this.next++
		this.callbacks.set(handle, callback)
		this.delays.push(delayMs)
		return handle
	}
	clearTimeout(handle: unknown): void { this.callbacks.delete(handle as number) }
	fire(): void {
		const callback = this.callbacks.values().next().value as (() => void) | undefined
		this.callbacks.clear()
		callback?.()
	}
}

class FakeVisibility implements DashboardVisibility {
	visible = true
	callback: (() => void) | undefined
	isVisible(): boolean { return this.visible }
	subscribe(callback: () => void): () => void {
		this.callback = callback
		return () => { this.callback = undefined }
	}
	set(value: boolean): void { this.visible = value; this.callback?.() }
}

type Setup<T extends DashboardTransport> = {
	controller: DashboardController
	transport: T
	view: FakeView
	clock: FakeClock
	visibility: FakeVisibility
}

function setup(): Setup<MockDashboardTransport>
function setup<T extends DashboardTransport>(transport: T): Setup<T>
function setup(transport: DashboardTransport = new MockDashboardTransport()): Setup<DashboardTransport> {
	return setupWith(mockDashboardReport, selection, transport)
}

function setupWith<T extends DashboardTransport>(
	report: DashboardReport,
	current: DashboardSelection,
	transport: T,
): Setup<T> {
	const view = new FakeView()
	const clock = new FakeClock()
	const visibility = new FakeVisibility()
	const controller = new DashboardController(report, current, transport, view, visibility, clock)
	return { controller, transport, view, clock, visibility }
}

function reportAt(date: string, asOf = `${date}T09:42:00.000Z`): DashboardReport {
	const report = structuredClone(mockDashboardReport)
	report.as_of = asOf
	report.timeline_date = date
	if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
	report.timeline.data.date = date
	return report
}

describe('dashboard interactions', () => {
	test('switches tracks, clears filters, and preserves the chosen date and range', async () => {
		const requests: DashboardSelection[] = []
		const transport: DashboardTransport = {
			async load(current) {
				requests.push(structuredClone(current))
				return { ...mockDashboardReport, track: current.track ?? 'all' }
			},
		}
		const current: DashboardSelection = { projects: ['cukup'], executors: ['amp-orb'], timeline_date: '2026-08-29', range: { preset: 30 } }
		const { controller } = setupWith(mockDashboardReport, current, transport)
		await controller.setTrack('all')
		expect(requests).toHaveLength(0)
		await controller.setTrack('work')
		expect(requests).toEqual([{ ...current, track: 'work', projects: [], executors: [] }])
		await controller.setTrack('work')
		expect(requests).toHaveLength(1)
		await controller.setTrack('play')
		expect(requests.at(-1)?.track).toBe('play')
	})

	test('does not apply an old track response after a newer selection', async () => {
		let finish: ((report: DashboardReport) => void) | undefined
		const requests: DashboardSelection[] = []
		const transport: DashboardTransport = {
			load(current) {
				requests.push(structuredClone(current))
				if (requests.length > 1) return Promise.resolve({ ...mockDashboardReport, track: current.track })
				return new Promise((resolve) => { finish = resolve })
			},
		}
		const { controller, view } = setup(transport)
		const first = controller.setTrack('work')
		await controller.setFilter('projects', 'cukup', true)
		expect(controller.getSelection().projects).toEqual([])
		await controller.setTrack('play')
		finish?.({ ...mockDashboardReport, track: 'work' })
		await first
		expect(requests.map((request) => request.track)).toEqual(['work', 'play'])
		expect(view.renders.some((render) => render.report.track === 'work')).toBeFalse()
		expect(view.renders.at(-1)?.report.track).toBe('play')
	})

	test('retains report scope on a failed track change and retries the requested track', async () => {
		let failing = true
		const transport: DashboardTransport = {
			async load(current) {
				if (failing) throw new Error('offline')
				return { ...mockDashboardReport, track: current.track }
			},
		}
		const { controller, view } = setup(transport)
		await controller.setTrack('work')
		expect(view.renders.at(-1)).toMatchObject({ selection: { track: 'work' }, filtersDisabled: true })
		expect(view.renders.at(-1)?.report.track ?? 'all').toBe('all')
		failing = false
		await controller.refresh()
		expect(view.renders.at(-1)).toMatchObject({ report: { track: 'work' }, filtersDisabled: false })
	})

	test('sends project and executor selections only through the injected transport body', async () => {
		const { controller, transport } = setup()
		await controller.setFilter('projects', 'cukup', true)
		await controller.setFilter('executors', 'amp-orb', true)
		expect(transport.requests.at(-1)).toEqual({
			projects: ['cukup'],
			executors: ['amp-orb'],
			range: { preset: 7 },
		})
	})

	test('coalesces filter changes made while a report request is in flight', async () => {
		let finishFirst: ((report: DashboardReport) => void) | undefined
		const requests: DashboardSelection[] = []
		const transport: DashboardTransport = {
			load(current) {
				requests.push(structuredClone(current))
				if (requests.length > 1) return Promise.resolve(mockDashboardReport)
				return new Promise((resolve) => { finishFirst = resolve })
			},
		}
		const { controller, view } = setup(transport)
		const first = controller.setFilter('projects', 'cukup', true)
		await controller.setFilter('executors', 'amp-orb', true)
		const superseded = reportAt('2026-08-30', '2026-08-30T09:42:00.000Z')
		finishFirst?.(superseded)
		await first
		expect(requests).toEqual([
			{ projects: ['cukup'], executors: [], range: { preset: 7 } },
			{ projects: ['cukup'], executors: ['amp-orb'], range: { preset: 7 } },
		])
		expect(view.renders.some((render) => render.report.as_of === superseded.as_of)).toBeFalse()
	})

	test('supports preset and bounded custom ranges', async () => {
		const { controller, transport, view } = setup()
		await controller.setPresetRange(90)
		controller.showCustomRange()
		await controller.applyCustomRange('2026-01-01', '2027-01-02')
		expect(view.announcements.at(-1)).toContain('no more than 366 days')
		expect(transport.requests).toHaveLength(1)
		await controller.applyCustomRange('2026-01-01', '2027-01-01')
		expect(transport.requests.at(-1)?.range).toEqual({ preset: 'custom', start_date: '2026-01-01', end_date: '2027-01-01' })
	})

	test('loads a selected heatmap date into the activity timeline', async () => {
		const { controller, transport } = setup()
		await controller.setTimelineDate('2026-08-29')
		expect(transport.requests.at(-1)).toEqual({
			projects: [],
			executors: [],
			timeline_date: '2026-08-29',
			range: { preset: 7 },
		})
	})

	test('clears filters across ISO weeks and preserves them within the selected week', async () => {
		const { controller, transport } = setup()
		await controller.setFilter('projects', 'cukup', true)
		await controller.setFilter('executors', 'amp-orb', true)

		await controller.setTimelineDate('2026-09-06')
		expect(transport.requests.at(-1)).toEqual({
			projects: ['cukup'],
			executors: ['amp-orb'],
			timeline_date: '2026-09-06',
			range: { preset: 7 },
		})

		await controller.setTimelineDate('2026-08-30')
		expect(transport.requests.at(-1)).toEqual({
			projects: [],
			executors: [],
			timeline_date: '2026-08-30',
			range: { preset: 7 },
		})
	})

	test('rejects obsolete filter options while a cross-week report is loading', async () => {
		let finish: ((report: DashboardReport) => void) | undefined
		const requests: DashboardSelection[] = []
		const transport: DashboardTransport = {
			load(current) {
				requests.push(structuredClone(current))
				return new Promise((resolve) => { finish = resolve })
			},
		}
		const { controller } = setup(transport)
		const switching = controller.setTimelineDate('2026-08-30')
		await Bun.sleep(0)
		await controller.setFilter('projects', 'cukup', true)
		expect(controller.getSelection().projects).toEqual([])
		finish?.(reportAt('2026-08-30'))
		await switching
		expect(requests).toEqual([
			{ projects: [], executors: [], timeline_date: '2026-08-30', range: { preset: 7 } },
		])
	})

	test('rerenders a queued cross-week selection before the existing request resolves', async () => {
		let finish: ((report: DashboardReport) => void) | undefined
		let requestCount = 0
		const transport: DashboardTransport = {
			load() {
				requestCount += 1
				if (requestCount > 1) return Promise.resolve(reportAt('2026-08-30'))
				return new Promise((resolve) => { finish = resolve })
			},
		}
		const { controller, view } = setup(transport)
		const polling = controller.refresh()
		await Bun.sleep(0)
		await controller.setTimelineDate('2026-08-30')
		const queued = view.renders.at(-1)
		expect(queued).toMatchObject({
			selection: { timeline_date: '2026-08-30', projects: [], executors: [] },
			refreshing: true,
		})
		finish?.(mockDashboardReport)
		await polling
		expect(requestCount).toBe(2)
	})

	test('uses the pending selected week after a failed week change', async () => {
		const requests: DashboardSelection[] = []
		const transport: DashboardTransport = {
			async load(current) {
				requests.push(structuredClone(current))
				throw new Error('network')
			},
		}
		const { controller } = setup(transport)
		await controller.setTimelineDate('2026-08-30')
		await controller.setTimelineDate('2026-08-29')
		expect(requests.at(-1)).toEqual({
			projects: [],
			executors: [],
			timeline_date: '2026-08-29',
			range: { preset: 7 },
		})
	})

	test('clears and reloads filters when polling rolls implicit today into a new Jakarta week', async () => {
		const oldReport = reportAt('2026-09-06', '2026-09-06T16:59:00.000Z')
		const newReport = reportAt('2026-09-07', '2026-09-06T17:01:00.000Z')
		const requests: DashboardSelection[] = []
		let finishClean: ((report: DashboardReport) => void) | undefined
		const transport: DashboardTransport = {
			async load(current) {
				requests.push(structuredClone(current))
				if (requests.length === 1) return structuredClone(newReport)
				return new Promise((resolve) => { finishClean = resolve })
			},
		}
		const current: DashboardSelection = {
			projects: ['cukup'],
			executors: ['amp-orb'],
			range: { preset: 7 },
		}
		const { controller, view } = setupWith(oldReport, current, transport)
		const refreshing = controller.refresh()
		await Bun.sleep(0)
		expect(requests).toEqual([
			current,
			{ projects: [], executors: [], range: { preset: 7 } },
		])
		expect(controller.getSelection()).toEqual({ projects: [], executors: [], range: { preset: 7 } })
		expect(view.renders.at(-1)).toMatchObject({
			selection: { projects: [], executors: [] },
			refreshing: true,
			filtersDisabled: true,
		})
		await controller.setFilter('projects', 'cukup', true)
		expect(controller.getSelection().projects).toEqual([])
		expect(requests).toHaveLength(2)
		finishClean?.(newReport)
		await refreshing
		expect(view.renders.some((render) =>
			render.report.timeline.state !== 'unavailable' &&
			render.report.timeline.data.date === '2026-09-07' &&
			render.selection.projects.length > 0
		)).toBeFalse()
	})

	test('preserves filters across an implicit same-week day rollover', async () => {
		const oldReport = reportAt('2026-09-07')
		const newReport = reportAt('2026-09-08')
		const transport = new MockDashboardTransport(newReport)
		const current: DashboardSelection = { projects: ['cukup'], executors: [], range: { preset: 7 } }
		const { controller } = setupWith(oldReport, current, transport)
		await controller.refresh()
		expect(transport.requests).toEqual([current])
		expect(controller.getSelection().projects).toEqual(['cukup'])
	})

	test('uses Jakarta as-of date when timeline is unavailable', async () => {
		const report = structuredClone(mockDashboardReport)
		report.as_of = '2026-08-30T17:30:00.000Z'
		report.timeline = { state: 'unavailable', message: 'No timeline response' }
		const transport = new MockDashboardTransport(report)
		const current: DashboardSelection = { projects: ['cukup'], executors: [], range: { preset: 7 } }
		const { controller } = setupWith(report, current, transport)
		await controller.setTimelineDate('2026-09-06')
		expect(transport.requests.at(-1)?.projects).toEqual(['cukup'])
	})

	test('keeps unavailable-timeline options tied to their historical report week', async () => {
		const historical = reportAt('2026-08-30', '2026-08-31T09:42:00.000Z')
		historical.timeline = { state: 'unavailable', message: 'No timeline response' }
		historical.available_projects = ['historical-only']
		const current = reportAt('2026-08-31')
		current.available_projects = ['current-only']
		let finish: ((report: DashboardReport) => void) | undefined
		const transport: DashboardTransport = {
			load() {
				return new Promise((resolve) => { finish = resolve })
			},
		}
		const selected: DashboardSelection = {
			projects: [],
			executors: [],
			timeline_date: '2026-08-30',
			range: { preset: 7 },
		}
		const { controller } = setupWith(historical, selected, transport)
		const filtering = controller.setFilter('projects', 'historical-only', true)
		await Bun.sleep(0)
		expect(controller.getSelection().projects).toEqual(['historical-only'])
		finish?.(historical)
		await filtering

		const switching = controller.setTimelineDate('2026-08-31')
		await Bun.sleep(0)
		await controller.setFilter('projects', 'historical-only', true)
		expect(controller.getSelection().projects).toEqual([])
		finish?.(current)
		await switching
	})

	test('polls every 30 seconds only while visible and resumes without an immediate request', async () => {
		const { controller, transport, clock, visibility } = setup()
		controller.start()
		expect(clock.delays).toEqual([30_000])
		visibility.set(false)
		expect(clock.callbacks.size).toBe(0)
		visibility.set(true)
		expect(clock.delays).toEqual([30_000, 30_000])
		clock.fire()
		await Bun.sleep(0)
		expect(transport.requests).toHaveLength(1)
		expect(clock.delays).toEqual([30_000, 30_000, 30_000])
		controller.stop()
		expect(clock.callbacks.size).toBe(0)
	})

	test('preserves previous panel values as stale when a whole refresh fails', async () => {
		const failing = { load: async () => { throw new Error('network') } }
		const { controller, view } = setup(failing)
		await controller.refresh()
		const latest = view.renders.at(-1)
		expect(latest?.report.overall.state).toBe('stale')
		expect(latest?.report.timeline.state).toBe('stale')
		expect(latest?.report.executors.state).toBe('stale')
		expect(latest?.report.overall.state === 'stale' && latest.report.overall.data.today.worked_minutes).toBe(380)
		expect(view.announcements).toEqual(['Dashboard refresh failed; last successful values remain visible'])
	})

	test('does not convert a panel that was already unavailable into a zero or stale value', () => {
		const report = structuredClone(mockDashboardReport)
		report.timeline = { state: 'unavailable', message: 'No timeline response' }
		expect(preserveReportAsStale(report).timeline).toEqual({ state: 'unavailable', message: 'No timeline response' })
	})
})
