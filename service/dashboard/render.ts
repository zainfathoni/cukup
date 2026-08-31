import type {
	DashboardReport,
	DashboardSelection,
	ExecutorSummary,
	Panel,
	TargetPeriod,
	Timeline,
	Trend,
} from './report.ts'

const chartWidth = 960
const chartHeight = 240

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

function formatMinutes(minutes: number): string {
	const hours = Math.floor(minutes / 60)
	const remainder = minutes % 60
	return hours === 0 ? `${remainder}m` : `${hours}h ${remainder}m`
}

function formatTimestamp(value: string | null, timezone: string): string {
	if (value === null) return 'No activity recorded'
	return new Intl.DateTimeFormat('en', {
		timeZone: timezone,
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value))
}

function targetCard(label: string, period: TargetPeriod): string {
	const difference =
		period.status === 'UNDER'
			? `${formatMinutes(period.difference_minutes)} remaining`
			: period.status === 'OVER'
				? `${formatMinutes(period.difference_minutes)} over target`
				: 'Target met'
	return `<article class="summary-card status-${period.status.toLowerCase()}">
		<p class="eyebrow">${label}</p>
		<p class="summary-value">${formatMinutes(period.worked_minutes)}</p>
		<p><span class="status-mark" aria-hidden="true"></span><strong>${period.status}</strong> — ${difference}</p>
		<p class="muted">Target ${formatMinutes(period.target_minutes)}</p>
	</article>`
}

function panelNotice<T>(panel: Panel<T>): string {
	if (panel.state === 'ready') return ''
	if (panel.state === 'unavailable') {
		return `<div class="panel-notice unavailable" role="status"><strong>Unavailable.</strong> ${escapeHtml(panel.message)} No value is shown as zero.</div>`
	}
	return `<div class="panel-notice stale" role="status"><strong>Stale data.</strong> ${escapeHtml(panel.message)} Last successful update <time datetime="${escapeHtml(panel.last_successful_at)}">${escapeHtml(panel.last_successful_at)}</time>.</div>`
}

function renderOverall(panel: DashboardReport['overall']): string {
	return `<section aria-labelledby="summary-title">
		<div class="section-heading"><div><p class="eyebrow">Authoritative, globally unioned</p><h2 id="summary-title">Working time</h2></div></div>
		${panelNotice(panel)}
		${panel.state === 'unavailable' ? '' : `<div class="summary-grid">${targetCard('Today', panel.data.today)}${targetCard('Current week', panel.data.week)}</div>`}
	</section>`
}

function filterGroup(
	legend: string,
	name: 'projects' | 'executors',
	values: string[],
	selected: string[],
): string {
	return `<fieldset><legend>${legend}</legend><div class="filter-options">${values
		.map(
			(value) => `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${selected.includes(value) ? 'checked' : ''} data-focus-key="${name}:${escapeHtml(value)}"> <span>${escapeHtml(value)}</span></label>`,
		)
		.join('')}</div></fieldset>`
}

function renderFilters(report: DashboardReport, selection: DashboardSelection, refreshing: boolean): string {
	return `<section class="filters" aria-labelledby="filters-title">
		<div class="section-heading"><div><p class="eyebrow">Targetless activity view</p><h2 id="filters-title">Filters</h2></div><button type="button" class="button" data-action="refresh" data-focus-key="refresh" ${refreshing ? 'disabled aria-disabled="true"' : ''}>${refreshing ? 'Refreshing…' : 'Refresh now'}</button></div>
		<p class="guidance"><strong>Activity is non-additive.</strong> Concurrent project and executor values overlap and must not be added. Multiple values within a filter use OR; project and executor filters combine with AND. Overall Working Time above never changes.</p>
		<div class="filter-grid">${filterGroup('Projects', 'projects', report.available_projects, selection.projects)}${filterGroup('Executors', 'executors', report.available_executors, selection.executors)}</div>
	</section>`
}

function zonedMinute(value: string, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(value))
	const part = (type: 'hour' | 'minute') => Number(parts.find((item) => item.type === type)?.value ?? 0)
	return part('hour') * 60 + part('minute')
}

function renderTimelineData(timeline: Timeline, timezone: string): string {
	const blocks = timeline.intervals
		.map((interval) => {
			const start = zonedMinute(interval.start, timezone)
			const end = Math.max(start + 1, zonedMinute(interval.end, timezone))
			const x = (start / 1440) * chartWidth
			const width = ((end - start) / 1440) * chartWidth
			return `<rect x="${x.toFixed(2)}" y="72" width="${width.toFixed(2)}" height="72" rx="6" class="timeline-block concurrency-${Math.min(interval.concurrency, 2)}"><title>${formatTimestamp(interval.start, timezone)} to ${formatTimestamp(interval.end, timezone)}; concurrency ${interval.concurrency}</title></rect>`
		})
		.join('')
	const ticks = [0, 6, 12, 18, 24]
		.map((hour) => `<text x="${(hour / 24) * chartWidth}" y="190" text-anchor="${hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'}">${String(hour).padStart(2, '0')}:00</text>`)
		.join('')
	const equivalents = timeline.intervals.length
		? `<ol class="text-equivalent">${timeline.intervals.map((interval) => `<li>${formatTimestamp(interval.start, timezone)}–${formatTimestamp(interval.end, timezone)}; concurrency ${interval.concurrency}</li>`).join('')}</ol>`
		: '<p>No activity intervals recorded today.</p>'
	return `<ul class="chart-legend"><li><span class="block-swatch" aria-hidden="true"></span>Single-source evidence</li><li><span class="block-swatch concurrent" aria-hidden="true"></span>Concurrent evidence</li></ul><p class="scroll-hint">Scroll the chart horizontally to see the full day.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable current-day timeline"><svg class="timeline-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="timeline-svg-title timeline-svg-desc"><title id="timeline-svg-title">Current-day activity timeline</title><desc id="timeline-svg-desc">Activity intervals across a 24-hour Jakarta day. Hatched blocks indicate concurrent evidence.</desc>${blocks}${ticks}</svg></div><details><summary>Timeline text equivalent</summary>${equivalents}</details>`
}

function renderTimeline(panel: DashboardReport['timeline'], timezone: string): string {
	return `<section aria-labelledby="timeline-title"><div class="section-heading"><div><p class="eyebrow">Current day · ${escapeHtml(timezone)}</p><h2 id="timeline-title">Activity timeline</h2></div></div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTimelineData(panel.data, timezone)}</section>`
}

function renderRange(selection: DashboardSelection): string {
	const preset = selection.range.preset
	const buttons = ([7, 30, 90] as const)
		.map((days) => `<button type="button" data-range="${days}" data-focus-key="range:${days}" aria-pressed="${preset === days}">${days} days</button>`)
		.join('')
	const custom = preset === 'custom' ? selection.range : { start_date: '', end_date: '' }
	return `<div class="range-controls" aria-label="Trend range">${buttons}<button type="button" data-range="custom" data-focus-key="range:custom" aria-pressed="${preset === 'custom'}">Custom</button></div>${preset === 'custom' ? `<div class="custom-range"><label>From <input type="date" name="start_date" value="${escapeHtml(custom.start_date)}" data-focus-key="start-date"></label><label>To <input type="date" name="end_date" value="${escapeHtml(custom.end_date)}" data-focus-key="end-date"></label><button type="button" class="button" data-action="apply-range" data-focus-key="apply-range">Apply range</button></div>` : ''}`
}

function renderTrendData(trend: Trend): string {
	const allPoints = trend.series.flatMap((series) => series.points)
	const maximum = Math.max(1, ...allPoints.map((point) => point.minutes))
	const pointCount = Math.max(2, ...trend.series.map((series) => series.points.length))
	const lines = trend.series
		.map((series, index) => {
			const points = series.points
				.map((point, pointIndex) => {
					const x = 40 + (pointIndex / (pointCount - 1)) * (chartWidth - 80)
					const y = 20 + (1 - point.minutes / maximum) * (chartHeight - 60)
					return `${x.toFixed(2)},${y.toFixed(2)}`
				})
				.join(' ')
			return `<polyline points="${points}" class="trend-line series-${index % 4}" vector-effect="non-scaling-stroke"><title>${escapeHtml(series.kind)}: ${escapeHtml(series.label)}</title></polyline>`
		})
		.join('')
	const axes = [maximum, Math.round(maximum / 2), 0]
		.map((minutes, index) => {
			const y = 20 + index * ((chartHeight - 60) / 2)
			return `<line x1="40" y1="${y}" x2="${chartWidth - 40}" y2="${y}" class="chart-grid"></line><text x="36" y="${y + 5}" text-anchor="end">${formatMinutes(minutes)}</text>`
		})
		.join('')
	const dateLabels = `<text x="40" y="${chartHeight - 5}" text-anchor="start">${escapeHtml(trend.start_date)}</text><text x="${chartWidth - 40}" y="${chartHeight - 5}" text-anchor="end">${escapeHtml(trend.end_date)}</text>`
	const legend = trend.series.map((series, index) => `<li><span class="legend-line series-${index % 4}" aria-hidden="true"></span><strong>${escapeHtml(series.kind)}</strong>: ${escapeHtml(series.label)}</li>`).join('')
	const rows = trend.series.map((series) => `<tr><th scope="row">${escapeHtml(series.kind)}: ${escapeHtml(series.label)}</th>${series.points.map((point) => `<td>${escapeHtml(point.date)}: ${formatMinutes(point.minutes)}</td>`).join('')}</tr>`).join('')
	return `<ul class="chart-legend">${legend}</ul><p class="scroll-hint">Scroll the chart horizontally to see the full range.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable daily activity trend"><svg class="trend-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="trend-svg-title trend-svg-desc"><title id="trend-svg-title">Daily activity trend</title><desc id="trend-svg-desc">Separate, non-stacked lines. Series overlap and are not additive.</desc>${axes}${dateLabels}${lines}</svg></div><details><summary>Trend data table</summary><div class="table-scroll"><table><caption>Daily minutes for each independent series</caption><tbody>${rows}</tbody></table></div></details>`
}

function renderTrend(panel: DashboardReport['trend'], selection: DashboardSelection): string {
	return `<section aria-labelledby="trend-title"><div class="section-heading"><div><p class="eyebrow">Independent, non-stacked series</p><h2 id="trend-title">Activity trend</h2></div>${renderRange(selection)}</div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTrendData(panel.data)}</section>`
}

function executorCard(executor: ExecutorSummary, timezone: string): string {
	const state = executor.credential_state === 'not-applicable' ? 'Managed workload identity' : `Credential ${executor.credential_state}`
	return `<article class="executor-card"><h3>${escapeHtml(executor.label)}</h3><dl><div><dt>Last activity</dt><dd>${formatTimestamp(executor.last_activity_at, timezone)}</dd></div><div><dt>Last synchronized</dt><dd>${formatTimestamp(executor.last_synchronized_at, timezone)}</dd></div><div><dt>Access</dt><dd><span class="credential credential-${executor.credential_state}">${escapeHtml(state)}</span></dd></div></dl></article>`
}

function renderExecutors(panel: DashboardReport['executors'], timezone: string): string {
	return `<section aria-labelledby="executors-title"><div class="section-heading"><div><p class="eyebrow">Operational context, not presence</p><h2 id="executors-title">Executors</h2></div></div><p class="guidance">Last activity is evidence, not an online/offline health signal. Last synchronized records when evidence reached Cukup.</p>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : `<div class="executor-grid">${panel.data.map((executor) => executorCard(executor, timezone)).join('')}</div>`}</section>`
}

export function renderDashboardContent(report: DashboardReport, selection: DashboardSelection, refreshing = false): string {
	const partial = [report.overall, report.timeline, report.trend, report.executors].some((panel) => panel.state !== 'ready')
	return `<header class="masthead"><div><p class="eyebrow">Personal dashboard</p><h1>Cukup</h1></div><div class="freshness ${partial ? 'freshness-partial' : ''}"><span class="freshness-mark" aria-hidden="true"></span><span>${partial ? '<strong>Partial report.</strong> ' : ''}Authoritative as of <time datetime="${escapeHtml(report.as_of)}">${formatTimestamp(report.as_of, report.timezone)}</time></span><span class="sr-only" role="status" aria-live="polite">${refreshing ? 'Refreshing dashboard' : partial ? 'Dashboard has stale or unavailable panels' : 'Dashboard up to date'}</span></div></header><main>${renderOverall(report.overall)}${renderFilters(report, selection, refreshing)}${renderTimeline(report.timeline, report.timezone)}${renderTrend(report.trend, selection)}${renderExecutors(report.executors, report.timezone)}</main>`
}

export function renderDashboardDocument(report: DashboardReport, selection: DashboardSelection): string {
	const serialized = JSON.stringify({ report, selection }).replaceAll('<', '\\u003c')
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Cukup dashboard</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><div id="dashboard-app">${renderDashboardContent(report, selection)}</div><script id="dashboard-data" type="application/json">${serialized}</script><script type="module" src="/assets/dashboard.js"></script></body></html>`
}
