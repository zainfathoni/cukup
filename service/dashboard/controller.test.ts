import { describe, expect, test } from 'bun:test'
import { DashboardController, preserveReportAsStale, type DashboardClock, type DashboardView, type DashboardVisibility } from './controller.ts'
import { MockDashboardTransport, mockDashboardReport } from './fixture.ts'
import type { DashboardReport, DashboardSelection, DashboardTransport } from './report.ts'

const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }

class FakeView implements DashboardView {
	renders: Array<{ report: DashboardReport; selection: DashboardSelection; refreshing: boolean }> = []
	announcements: string[] = []
	render(report: DashboardReport, current: DashboardSelection, refreshing: boolean): void {
		this.renders.push({ report: structuredClone(report), selection: structuredClone(current), refreshing })
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
	const view = new FakeView()
	const clock = new FakeClock()
	const visibility = new FakeVisibility()
	const controller = new DashboardController(mockDashboardReport, selection, transport, view, visibility, clock)
	return { controller, transport, view, clock, visibility }
}

describe('dashboard interactions', () => {
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
		const { controller } = setup(transport)
		const first = controller.setFilter('projects', 'cukup', true)
		await controller.setFilter('executors', 'amp-orb', true)
		finishFirst?.(mockDashboardReport)
		await first
		expect(requests).toEqual([
			{ projects: ['cukup'], executors: [], range: { preset: 7 } },
			{ projects: ['cukup'], executors: ['amp-orb'], range: { preset: 7 } },
		])
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
