import { describe, expect, test } from 'bun:test'
import { mockDashboardReport } from './fixture.ts'
import { renderDashboardContent, renderDashboardDocument } from './render.ts'
import type { DashboardSelection } from './report.ts'

const selection: DashboardSelection = { projects: [], executors: [], range: { preset: 7 } }

describe('dashboard rendering', () => {
	test('renders the semantic hierarchy, accessible chart equivalents, and non-additive guidance', () => {
		const html = renderDashboardDocument(mockDashboardReport, selection)
		expect(html).toStartWith('<!doctype html><html lang="en">')
		expect(html).toContain('<main>')
		expect(html).toContain('Today')
		expect(html).toContain('Current week')
		expect(html).toContain('Authoritative as of')
		expect(html).toContain('<fieldset><legend>Projects</legend>')
		expect(html).toContain('<fieldset><legend>Executors</legend>')
		expect(html).toContain('Activity is non-additive.')
		expect(html).toContain('must not be added')
		expect(html).toContain('role="img" aria-labelledby="timeline-svg-title timeline-svg-desc"')
		expect(html).toContain('Timeline text equivalent')
		expect(html).toContain('Concurrent evidence')
		expect(html).toContain('tabindex="0" role="region" aria-label="Scrollable current-day timeline"')
		expect(html).toContain('role="img" aria-labelledby="trend-svg-title trend-svg-desc"')
		expect(html).toContain('View daily values')
		expect(html).toContain('Exact values behind the chart, provided for comparison and as a text alternative.')
		expect(html).toContain('<thead><tr><th scope="col">Date</th>')
		expect(html).toContain('<tr><th scope="row">2026-08-25</th><td>6h 50m</td><td>2h 0m</td></tr>')
		expect(html).toContain('class="chart-grid"')
		expect(html).toContain('aria-label="Scrollable daily activity trend"')
		expect(html).toContain('Last activity is evidence, not an online/offline health signal.')
		const targetX = Number(html.match(/class="meter-target" x1="([^"]+)"/)?.[1])
		expect(targetX).toBeLessThan(470)
	})

	test('renders native keyboard controls and keeps filter state out of resource URLs', () => {
		const selected: DashboardSelection = {
			projects: ['cukup'],
			executors: ['amp-orb'],
			range: { preset: 'custom', start_date: '2026-08-01', end_date: '2026-08-31' },
		}
		const html = renderDashboardDocument(mockDashboardReport, selected)
		expect(html).toContain('name="projects" value="cukup" checked')
		expect(html).toContain('name="executors" value="amp-orb" checked')
		expect(html).toContain('type="date" name="start_date" value="2026-08-01"')
		expect(html).toContain('data-action="refresh"')
		expect(html).toContain('href="/assets/dashboard.css"')
		expect(html).toContain('src="/assets/dashboard.js"')
		expect(html).not.toContain('/assets/dashboard.css?')
		expect(html).not.toContain('/assets/dashboard.js?')
	})

	test('preserves stale values, identifies partial state in text, and does not invent unavailable zeroes', () => {
		const partial = structuredClone(mockDashboardReport)
		partial.timeline = { state: 'unavailable', message: 'Timeline query failed.' }
		const html = renderDashboardContent(partial, selection)
		expect(html).toContain('<strong>Stale data.</strong>')
		expect(html).toContain('<strong>Partial report.</strong>')
		expect(html).toContain('Last successful update')
		expect(html).toContain('<strong>Unavailable.</strong> Timeline query failed. No value is shown as zero.')
		expect(html).not.toContain('No activity intervals recorded today.')
		expect(html).toContain('nixos-workstation')
	})

	test('escapes labels in markup and embedded initial state', () => {
		const report = structuredClone(mockDashboardReport)
		report.available_projects = ['<script>alert(1)</script>']
		const html = renderDashboardDocument(report, selection)
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(html).toContain('\\u003cscript>')
	})
})
