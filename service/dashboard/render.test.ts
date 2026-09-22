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
		expect(html).toContain('Options reflect activity in the selected ISO week.')
		expect(html).toContain('Choosing a day in another week clears filters.')
		expect(html).toContain('must not be added')
		expect(html).toContain('role="img" aria-labelledby="timeline-svg-title timeline-svg-desc"')
		expect(html).toContain('Timeline text equivalent')
		expect(html).toContain('Concurrent evidence')
		expect(html).toContain('tabindex="0" role="region" aria-label="Scrollable current-day timeline"')
		expect(html).toContain('role="img" aria-labelledby="trend-svg-title trend-svg-desc"')
		expect(html).toContain('View daily values')
		expect(html).toContain('Exact values behind the chart, provided for comparison and as a text alternative.')
		expect(html).toContain('<thead><tr><th scope="col">Date</th>')
		expect(html).toContain(
			'<tr><th scope="row">2026-08-25</th><td>6h 50m</td><td>2h 0m</td><td>8h 0m</td><td>UNDER</td><td>4</td><td>08:30–18:10</td>',
		)
		expect(html).toContain('<th scope="col">Target</th><th scope="col">Status</th>')
		expect(html).toContain('class="chart-grid"')
		expect(html).toContain('aria-label="Scrollable daily activity trend"')
		expect(html).toContain('class="trend-hover" tabindex="0" aria-label="2026-08-25: overall Overall working time: 6h 50m, project cukup: 2h 0m"')
		expect(html).toContain('class="trend-hover-line"')
		expect(html).toContain('class="trend-hover-tag series-0"')
		expect(html).toContain('class="trend-hover-tag series-1"')
		expect(html).toContain('Hover or focus a day to see that day’s value on every line.')
		expect(html).toContain('Last activity is evidence, not an online/offline health signal.')
		const targetX = Number(html.match(/class="meter-target" x1="([^"]+)"/)?.[1])
		expect(targetX).toBeLessThan(470)
		expect(html.indexOf('id="trend-title"')).toBeLessThan(html.indexOf('id="filters-title"'))
	})

	test('draws the timeline as lanes that name their dimension and keep overlap non-additive', () => {
		const html = renderDashboardContent(mockDashboardReport, selection)
		expect(html).toContain('class="gantt-chart"')
		expect(html).toContain('All selected')
		expect(html).toContain('class="gantt-group" x="0"')
		expect(html).toContain('>By project</text>')
		expect(html).toContain('>By executor</text>')
		expect(html).toContain('class="gantt-bar gantt-union concurrency-2"')
		expect(html).toContain('class="gantt-bar gantt-project"')
		expect(html).toContain('class="gantt-bar gantt-executor"')
		expect(html).toContain('class="verdict-grid activity-period-grid"')
		expect(html).toContain('<span>Selected day</span>')
		expect(html).toContain('<span class="verdict-figure">6h 20m</span>')
		expect(html).toContain('Selected day: 6h 20m worked against target 8h 0m')
		expect(html).toContain('<p class="verdict-caption">1h 40m remaining</p>')
		expect(html).toContain('<span>Selected ISO week</span>')
		expect(html).toContain('Selected ISO week: 6h 20m worked against target 40h 0m')
		expect(html).toContain('its full Monday–Sunday 2026-W36 week, not separate project or executor quotas')
		expect(html).not.toContain('Time by project and executor')
		expect(html).not.toContain('period-breakdown')
		expect(html).toContain('line up vertically describe the same minutes and must not be added')
		expect(html).toContain('bars are unioned within a lane')
		// The label gutter is fixed, so a long slug is trimmed but stays readable in full.
		expect(html).toContain('>deep-work-instru…<title>deep-work-instrumentation-and-attribution</title>')
		expect(html).toContain('class="gantt-now"')
		expect(html).toContain('>now</text>')
		expect(html).toContain('<h4>By project</h4>')
	})

	test('opens a hover detail card per heatmap day and repeats it in the keyboard-reachable table', () => {
		const html = renderDashboardContent(mockDashboardReport, selection)
		expect(html).toContain('class="heat-board heat-roomy"')
		expect(html).toContain('<ol class="heat-grid" aria-label="Calendar heatmap')
		expect(html).toContain('data-timeline-date="2026-08-31"')
		expect(html).toContain('aria-label="Inspect Mon, Aug 31, 2026 in the activity timeline"')
		expect(html).toContain('class="heat-cell heat-3 heat-selected-week heat-selected" data-timeline-date="2026-08-31"')
		expect(html.match(/heat-selected-week/g)).toHaveLength(1)
		expect(html).toContain('outlined cells mark the selected week')
		expect(html).toContain('class="heat-tip status-under tip-start"')
		expect(html).toContain('<p class="tip-date">Mon, Aug 31, 2026</p>')
		expect(html).toContain('<span class="tip-figure">6h 20m</span><span class="tip-stamp">UNDER</span>')
		expect(html).toContain('Target 8h 0m · 1h 40m remaining')
		expect(html).toContain('<dt>Projects</dt><dd>cukup 4h 20m · personal-site 1h 36m · deep-work')
		expect(html).toContain('7 intervals · 08:15–16:30')
		expect(html).toContain('Activity overlaps; never add it up.')
		// The all-day-off day states its emptiness rather than showing a breakdown.
		expect(html).toContain('class="heat-tip status-complete')
		expect(html).toContain('No working time recorded.')
		// The table carries the same detail without requiring the interactive card.
		expect(html).toContain('<td>7</td><td>08:15–16:30</td>')
	})

	test('marks the selected heatmap date and renders its matching timeline', () => {
		const report = structuredClone(mockDashboardReport)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		report.timeline.data.date = '2026-08-29'
		report.timeline.data.minutes = 0
		report.timeline.data.week = '2026-W35'
		report.timeline.data.week_minutes = 0
		report.timeline.data.day_period = {
			status: 'COMPLETE',
			worked_minutes: 0,
			target_minutes: 0,
			difference_minutes: 0,
		}
		report.timeline.data.week_period = {
			status: 'UNDER',
			worked_minutes: 0,
			target_minutes: 2_400,
			difference_minutes: 2_400,
		}
		report.timeline.data.intervals = []
		report.timeline.data.lanes = []
		const html = renderDashboardContent(report, { ...selection, timeline_date: '2026-08-29' })
		expect(html).toContain('class="heat-cell heat-3 heat-selected-week heat-selected" data-timeline-date="2026-08-29"')
		expect(html.match(/heat-selected-week/g)).toHaveLength(6)
		expect(html).toContain('<span>Selected day</span>')
		expect(html).toContain('<p class="verdict-caption">Target met</p>')
	})

	test('shows over-target status and duration for a selected historical week', () => {
		const report = structuredClone(mockDashboardReport)
		if (report.timeline.state === 'unavailable') throw new Error('Expected timeline')
		report.timeline.data.date = '2026-08-28'
		report.timeline.data.week = '2026-W35'
		report.timeline.data.week_period = {
			status: 'OVER',
			worked_minutes: 4_264,
			target_minutes: 2_400,
			difference_minutes: 1_864,
		}
		const html = renderDashboardContent(report, {
			...selection,
			timeline_date: '2026-08-28',
		})
		expect(html).toContain('<span class="verdict-figure">71h 4m</span>')
		expect(html).toContain('Selected ISO week: 71h 4m worked against target 40h 0m')
		expect(html).toContain('<p class="verdict-caption">31h 4m over target</p>')
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

	test('uses report-level timeline date for active-week rendering when timeline is unavailable', () => {
		const partial = structuredClone(mockDashboardReport)
		partial.as_of = '2026-08-30T17:30:00.000Z'
		partial.timeline_date = '2026-08-31'
		partial.timeline = { state: 'unavailable', message: 'Timeline query failed.' }
		const html = renderDashboardContent(partial, selection)
		expect(html).toContain('class="heat-cell heat-3 heat-selected-week heat-selected" data-timeline-date="2026-08-31"')
	})

	test('keeps historical filters enabled when their timeline panel is unavailable', () => {
		const partial = structuredClone(mockDashboardReport)
		partial.as_of = '2026-08-31T09:42:00.000Z'
		partial.timeline_date = '2026-08-30'
		partial.timeline = { state: 'unavailable', message: 'Timeline query failed.' }
		const html = renderDashboardContent(partial, {
			...selection,
			timeline_date: '2026-08-30',
		})
		expect(html).toContain('<fieldset><legend>Projects</legend>')
		expect(html).not.toContain('<fieldset disabled>')
	})

	test('disables obsolete options while a different selected week is loading', () => {
		const html = renderDashboardContent(mockDashboardReport, {
			...selection,
			timeline_date: '2026-08-30',
		}, true)
		expect(html).toContain('<fieldset disabled><legend>Projects</legend>')
		expect(html).toContain('<fieldset disabled><legend>Executors</legend>')
	})

	test('allows the controller to disable filters during an implicit week rollover', () => {
		const html = renderDashboardContent(mockDashboardReport, selection, true, true)
		expect(html).toContain('<fieldset disabled><legend>Projects</legend>')
		expect(html).toContain('<fieldset disabled><legend>Executors</legend>')
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
