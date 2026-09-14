import type { DashboardReport, DashboardSelection, DashboardTransport, Panel } from './report.ts'
import { deliverShadowDisclosures } from '../shadow-disclosures.ts'

export interface DashboardView {
	render(report: DashboardReport, selection: DashboardSelection, refreshing: boolean): void
	announce(message: string): void
}

export interface DashboardClock {
	setTimeout(callback: () => void, delayMs: number): unknown
	clearTimeout(handle: unknown): void
}

export interface DashboardVisibility {
	isVisible(): boolean
	subscribe(callback: () => void): () => void
}

const pollingIntervalMs = 30_000

function stalePanel<T>(panel: Panel<T>, lastSuccessfulAt: string): Panel<T> {
	if (panel.state === 'unavailable') return panel
	return {
		state: 'stale',
		data: panel.data,
		last_successful_at: panel.state === 'stale' ? panel.last_successful_at : lastSuccessfulAt,
		message: 'Refresh failed. Showing the last successful values.',
	}
}

function staleShadowDisclosures(
	panel: DashboardReport['shadow_disclosures'],
	lastSuccessfulAt: string,
): DashboardReport['shadow_disclosures'] {
	if (panel.state === 'unavailable') return panel
	const delivery = deliverShadowDisclosures('stale', panel.data.lanes)
	if (delivery.availability !== 'stale') throw new Error('Expected stale disclosure delivery')
	return {
		state: 'stale',
		data: { ...panel.data, lanes: delivery.disclosures },
		last_successful_at: panel.state === 'stale' ? panel.last_successful_at : lastSuccessfulAt,
		message: 'Refresh failed. Retained disclosure context is shown with synchronization unknown.',
	}
}

export function preserveReportAsStale(report: DashboardReport): DashboardReport {
	return {
		...report,
		overall: stalePanel(report.overall, report.as_of),
		timeline: stalePanel(report.timeline, report.as_of),
		trend: stalePanel(report.trend, report.as_of),
		executors: stalePanel(report.executors, report.as_of),
		shadow_disclosures: staleShadowDisclosures(report.shadow_disclosures, report.as_of),
	}
}

export class DashboardController {
	private report: DashboardReport
	private selection: DashboardSelection
	private timer: unknown | undefined
	private refreshing = false
	private refreshQueued = false
	private unsubscribeVisibility: (() => void) | undefined

	constructor(
		report: DashboardReport,
		selection: DashboardSelection,
		private readonly transport: DashboardTransport,
		private readonly view: DashboardView,
		private readonly visibility: DashboardVisibility,
		private readonly clock: DashboardClock,
	) {
		this.report = report
		this.selection = structuredClone(selection)
	}

	start(): void {
		if (this.unsubscribeVisibility) return
		this.unsubscribeVisibility = this.visibility.subscribe(() => this.visibilityChanged())
		this.schedulePoll()
	}

	stop(): void {
		this.clearPoll()
		this.unsubscribeVisibility?.()
		this.unsubscribeVisibility = undefined
	}

	async refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshQueued = true
			return
		}
		this.clearPoll()
		this.refreshing = true
		this.view.render(this.report, this.selection, true)
		try {
			this.report = await this.transport.load(structuredClone(this.selection))
			this.view.announce('Dashboard updated')
		} catch {
			this.report = preserveReportAsStale(this.report)
			this.view.announce('Dashboard refresh failed; last successful values remain visible')
		} finally {
			this.refreshing = false
			this.view.render(this.report, this.selection, false)
			if (this.refreshQueued) {
				this.refreshQueued = false
				await this.refresh()
			} else {
				this.schedulePoll()
			}
		}
	}

	async setFilter(kind: 'projects' | 'executors', value: string, checked: boolean): Promise<void> {
		const values = new Set(this.selection[kind])
		if (checked) values.add(value)
		else values.delete(value)
		this.selection = { ...this.selection, [kind]: [...values] }
		await this.refresh()
	}

	async setPresetRange(preset: 7 | 30 | 90): Promise<void> {
		this.selection = { ...this.selection, range: { preset } }
		await this.refresh()
	}

	async setTimelineDate(date: string): Promise<void> {
		this.selection = { ...this.selection, timeline_date: date }
		await this.refresh()
	}

	showCustomRange(): void {
		const trend = this.report.trend
		const dates = trend.state === 'unavailable' ? { start_date: '', end_date: '' } : trend.data
		this.selection = {
			...this.selection,
			range: { preset: 'custom', start_date: dates.start_date, end_date: dates.end_date },
		}
		this.view.render(this.report, this.selection, false)
	}

	async applyCustomRange(startDate: string, endDate: string): Promise<void> {
		const durationDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
		if (!startDate || !endDate || startDate > endDate || !Number.isFinite(durationDays) || durationDays > 365) {
			this.view.announce('Choose a valid custom date range of no more than 366 days')
			return
		}
		this.selection = {
			...this.selection,
			range: { preset: 'custom', start_date: startDate, end_date: endDate },
		}
		await this.refresh()
	}

	getSelection(): DashboardSelection {
		return structuredClone(this.selection)
	}

	private visibilityChanged(): void {
		if (this.visibility.isVisible()) this.schedulePoll()
		else this.clearPoll()
	}

	private schedulePoll(): void {
		if (this.timer !== undefined || this.refreshing || !this.visibility.isVisible()) return
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined
			void this.refresh()
		}, pollingIntervalMs)
	}

	private clearPoll(): void {
		if (this.timer === undefined) return
		this.clock.clearTimeout(this.timer)
		this.timer = undefined
	}
}
