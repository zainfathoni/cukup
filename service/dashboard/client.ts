import { DashboardController, type DashboardView } from './controller.ts'
import { renderDashboardContent } from './render.ts'
import type { DashboardReport, DashboardSelection, DashboardTransport } from './report.ts'

type InitialData = { report: DashboardReport; selection: DashboardSelection }

export class HttpDashboardTransport implements DashboardTransport {
	constructor(private readonly endpoint = '/dashboard/report') {}

	async load(selection: DashboardSelection): Promise<DashboardReport> {
		const response = await fetch(this.endpoint, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(selection),
		})
		if (!response.ok) throw new Error('Dashboard report request failed')
		return (await response.json()) as DashboardReport
	}
}

class DomDashboardView implements DashboardView {
	private readonly announcements: HTMLElement
	private lastFocused: string | undefined

	constructor(private readonly root: HTMLElement) {
		this.announcements = document.createElement('div')
		this.announcements.className = 'sr-only'
		this.announcements.setAttribute('role', 'status')
		this.announcements.setAttribute('aria-live', 'polite')
		document.body.append(this.announcements)
	}

	render(
		report: DashboardReport,
		selection: DashboardSelection,
		refreshing: boolean,
		filtersDisabled: boolean,
	): void {
		if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
			this.lastFocused = document.activeElement.dataset.focusKey
		}
		this.root.innerHTML = renderDashboardContent(report, selection, refreshing, filtersDisabled)
		if (this.lastFocused && !refreshing) {
			for (const element of this.root.querySelectorAll<HTMLElement>('[data-focus-key]')) {
				if (element.dataset.focusKey === this.lastFocused) {
					element.focus()
					break
				}
			}
		}
	}

	announce(message: string): void {
		this.announcements.textContent = ''
		requestAnimationFrame(() => {
			this.announcements.textContent = message
		})
	}
}

export function startDashboard(
	root: HTMLElement,
	initial: InitialData,
	transport: DashboardTransport = new HttpDashboardTransport(),
): DashboardController {
	const view = new DomDashboardView(root)
	const controller = new DashboardController(
		initial.report,
		initial.selection,
		transport,
		view,
		{
			isVisible: () => document.visibilityState === 'visible',
			subscribe(callback) {
				document.addEventListener('visibilitychange', callback)
				return () => document.removeEventListener('visibilitychange', callback)
			},
		},
		{ setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: (handle) => window.clearTimeout(handle as number) },
	)

	root.addEventListener('change', (event) => {
		const input = event.target
		if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return
		if (input.name === 'projects' || input.name === 'executors') {
			void controller.setFilter(input.name, input.value, input.checked)
		}
	})

	root.addEventListener('click', (event) => {
		const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
		if (!button) return
		if (button.dataset.action === 'refresh') void controller.refresh()
		if (button.dataset.timelineDate) {
			void controller.setTimelineDate(button.dataset.timelineDate).then(() => {
				const title = root.querySelector<HTMLElement>('#timeline-title')
				title?.scrollIntoView({ block: 'start' })
				title?.focus()
			})
		}
		if (button.dataset.action === 'apply-range') {
			const start = root.querySelector<HTMLInputElement>('input[name="start_date"]')?.value ?? ''
			const end = root.querySelector<HTMLInputElement>('input[name="end_date"]')?.value ?? ''
			void controller.applyCustomRange(start, end)
		}
		if (button.dataset.range === 'custom') controller.showCustomRange()
		if (button.dataset.range === '7' || button.dataset.range === '30' || button.dataset.range === '90') {
			void controller.setPresetRange(Number(button.dataset.range) as 7 | 30 | 90)
		}
	})

	controller.start()
	return controller
}

if (typeof document !== 'undefined') {
	const root = document.querySelector<HTMLElement>('#dashboard-app')
	const data = document.querySelector<HTMLScriptElement>('#dashboard-data')
	if (root && data?.textContent) startDashboard(root, JSON.parse(data.textContent) as InitialData)
}
