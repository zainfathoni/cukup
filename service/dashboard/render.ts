import type {
	DashboardReport,
	DashboardSelection,
	ExecutorSummary,
	Panel,
	TargetPeriod,
	Timeline,
	Trend,
	TrendSeries,
} from './report.ts'

const chartWidth = 960
const chartHeight = 260
const timelineHeight = 210
const meterWidth = 480
const meterHeight = 34
const heatGap = 4
const heatLabelWidth = 30
const heatLabelHeight = 18
const heatTargetWidth = 460

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

function formatCivilDate(date: string): string {
	const parsed = Date.parse(`${date}T00:00:00Z`)
	if (!Number.isFinite(parsed)) return date
	return new Intl.DateTimeFormat('en', {
		timeZone: 'UTC',
		day: 'numeric',
		month: 'short',
	}).format(new Date(parsed))
}

/** Monday-based weekday index for a civil `YYYY-MM-DD` date, or null when unparseable. */
function weekdayIndex(date: string): number | null {
	const parsed = Date.parse(`${date}T00:00:00Z`)
	if (!Number.isFinite(parsed)) return null
	return (new Date(parsed).getUTCDay() + 6) % 7
}

/* ---------- Overall verdict ---------- */

/**
 * Worked-versus-target meter drawn as SVG geometry. The Content Security Policy
 * forbids inline style attributes, so proportions become element attributes.
 */
function verdictMeter(period: TargetPeriod, label: string): string {
	const scale = Math.max(period.worked_minutes, period.target_minutes, 1) * 1.1
	const inner = meterWidth - 4
	const worked = Math.max(0, Math.min(inner, (period.worked_minutes / scale) * inner))
	const targetX = 2 + (period.target_minutes / scale) * inner
	const description = `${formatMinutes(period.worked_minutes)} worked against a ${formatMinutes(period.target_minutes)} target`
	return `<svg class="verdict-meter" viewBox="0 0 ${meterWidth} ${meterHeight}" role="img" aria-label="${escapeHtml(`${label}: ${description}`)}" preserveAspectRatio="none"><rect class="meter-track" x="1" y="1" width="${meterWidth - 2}" height="${meterHeight - 2}" rx="8" vector-effect="non-scaling-stroke"></rect><rect class="meter-fill" x="2" y="2" width="${worked.toFixed(2)}" height="${meterHeight - 4}" rx="7" vector-effect="non-scaling-stroke"></rect><line class="meter-target" x1="${targetX.toFixed(2)}" y1="0" x2="${targetX.toFixed(2)}" y2="${meterHeight}" vector-effect="non-scaling-stroke"></line></svg>`
}

function verdictCard(label: string, period: TargetPeriod): string {
	const caption =
		period.status === 'UNDER'
			? `${formatMinutes(period.difference_minutes)} remaining`
			: period.status === 'OVER'
				? `${formatMinutes(period.difference_minutes)} over target`
				: 'Target met'
	return `<article class="verdict status-${period.status.toLowerCase()}">
		<p class="verdict-label"><span>${escapeHtml(label)}</span><span class="verdict-stamp"><span class="status-mark" aria-hidden="true"></span>${period.status}</span></p>
		<p><span class="verdict-figure">${formatMinutes(period.worked_minutes)}</span></p>
		${verdictMeter(period, label)}
		<p class="verdict-caption">${caption}</p>
		<p class="verdict-target">Target ${formatMinutes(period.target_minutes)} · dashed mark on the meter</p>
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
	return `<section class="hero" aria-labelledby="summary-title">
		<div class="section-heading"><div><p class="eyebrow">Authoritative, globally unioned</p><h2 id="summary-title">Working time</h2></div></div>
		${panelNotice(panel)}
		${panel.state === 'unavailable' ? '' : `<div class="verdict-grid">${verdictCard('Today', panel.data.today)}${verdictCard('Current week', panel.data.week)}</div>`}
	</section>`
}

/* ---------- Filters ---------- */

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

/* ---------- Timeline ---------- */

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
	const trackTop = 56
	const trackHeight = 96
	const blocks = timeline.intervals
		.map((interval) => {
			const start = zonedMinute(interval.start, timezone)
			const end = Math.max(start + 1, zonedMinute(interval.end, timezone))
			const x = (start / 1440) * chartWidth
			const width = Math.max(4, ((end - start) / 1440) * chartWidth)
			return `<rect x="${x.toFixed(2)}" y="${trackTop + 8}" width="${width.toFixed(2)}" height="${trackHeight - 16}" rx="7" class="timeline-block concurrency-${Math.min(interval.concurrency, 2)}"><title>${formatTimestamp(interval.start, timezone)} to ${formatTimestamp(interval.end, timezone)}; concurrency ${interval.concurrency}</title></rect>`
		})
		.join('')
	const gridlines = [3, 6, 9, 12, 15, 18, 21]
		.map((hour) => {
			const x = ((hour * 60) / 1440) * chartWidth
			return `<line class="chart-grid" x1="${x.toFixed(2)}" y1="${trackTop}" x2="${x.toFixed(2)}" y2="${trackTop + trackHeight}"></line>`
		})
		.join('')
	const ticks = [0, 6, 12, 18, 24]
		.map(
			(hour) =>
				`<text x="${(hour / 24) * chartWidth}" y="${trackTop + trackHeight + 26}" text-anchor="${hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'}">${String(hour).padStart(2, '0')}:00</text>`,
		)
		.join('')
	const worked = `<text x="0" y="30" class="timeline-empty">${escapeHtml(timeline.date)} · ${timeline.intervals.length} interval${timeline.intervals.length === 1 ? '' : 's'}</text>`
	const equivalents = timeline.intervals.length
		? `<ol class="text-equivalent">${timeline.intervals.map((interval) => `<li>${formatTimestamp(interval.start, timezone)}–${formatTimestamp(interval.end, timezone)}; concurrency ${interval.concurrency}</li>`).join('')}</ol>`
		: '<p>No activity intervals recorded today.</p>'
	return `<ul class="chart-legend"><li><span class="block-swatch" aria-hidden="true"></span>Single-source evidence</li><li><span class="block-swatch concurrent" aria-hidden="true"></span>Concurrent evidence</li></ul><p class="scroll-hint">Scroll the chart horizontally to see the full day.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable current-day timeline"><svg class="timeline-chart" viewBox="0 0 ${chartWidth} ${timelineHeight}" role="img" aria-labelledby="timeline-svg-title timeline-svg-desc"><title id="timeline-svg-title">Current-day activity timeline</title><desc id="timeline-svg-desc">Activity intervals across a 24-hour Jakarta day. Dashed yellow blocks indicate concurrent evidence.</desc>${worked}<rect class="chart-frame" x="1" y="${trackTop}" width="${chartWidth - 2}" height="${trackHeight}" rx="10"></rect>${gridlines}${blocks}${ticks}</svg></div><details><summary>Timeline text equivalent</summary>${equivalents}</details>`
}

function renderTimeline(panel: DashboardReport['timeline'], timezone: string): string {
	return `<section aria-labelledby="timeline-title"><div class="section-heading"><div><p class="eyebrow">Current day · ${escapeHtml(timezone)}</p><h2 id="timeline-title">Activity timeline</h2></div></div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTimelineData(panel.data, timezone)}</section>`
}

/* ---------- Trend ---------- */

function renderRange(selection: DashboardSelection): string {
	const preset = selection.range.preset
	const buttons = ([7, 30, 90] as const)
		.map(
			(days) =>
				`<button type="button" data-range="${days}" data-focus-key="range:${days}" aria-pressed="${preset === days}">${days} days</button>`,
		)
		.join('')
	const custom = preset === 'custom' ? selection.range : { start_date: '', end_date: '' }
	return `<div class="range-controls" role="group" aria-label="Trend range">${buttons}<button type="button" data-range="custom" data-focus-key="range:custom" aria-pressed="${preset === 'custom'}">Custom</button></div>${preset === 'custom' ? `<div class="custom-range"><label>From <input type="date" name="start_date" value="${escapeHtml(custom.start_date)}" data-focus-key="start-date"></label><label>To <input type="date" name="end_date" value="${escapeHtml(custom.end_date)}" data-focus-key="end-date"></label><button type="button" class="button" data-action="apply-range" data-focus-key="apply-range">Apply range</button></div>` : ''}`
}

/**
 * Calendar heatmap of the globally unioned Overall series. Columns are
 * Monday-started weeks; intensity is quartered against the busiest day.
 */
function renderHeatmap(series: TrendSeries | undefined): string {
	if (!series || series.points.length === 0) return ''
	const first = weekdayIndex(series.points[0]!.date)
	if (first === null) return ''
	const busiest = Math.max(1, ...series.points.map((point) => point.minutes))
	const columns = Math.ceil((first + series.points.length) / 7)
	const heatCell = Math.max(14, Math.min(30, Math.floor(heatTargetWidth / columns) - heatGap))
	const heatStep = heatCell + heatGap
	const cells = series.points
		.map((point, index) => {
			const offset = first + index
			const column = Math.floor(offset / 7)
			const row = offset % 7
			const level = point.minutes === 0 ? 0 : Math.min(4, Math.ceil((point.minutes / busiest) * 4))
			const x = heatLabelWidth + column * heatStep
			const y = heatLabelHeight + row * heatStep
			return `<rect class="heat-cell heat-${level}" x="${x}" y="${y}" width="${heatCell}" height="${heatCell}" rx="4"><title>${escapeHtml(point.date)}: ${formatMinutes(point.minutes)}</title></rect>`
		})
		.join('')
	const weekdayLabels = ['M', '', 'W', '', 'F', '', 'S']
		.map((label, row) =>
			label ? `<text x="0" y="${heatLabelHeight + row * heatStep + heatCell - 3}">${label}</text>` : '',
		)
		.join('')
	const monthLabels = series.points
		.map((point, index) => {
			const offset = first + index
			if (offset % 7 !== 0 && index !== 0) return ''
			const day = Number(point.date.slice(8, 10))
			if (day > 7 && index !== 0) return ''
			return `<text x="${heatLabelWidth + Math.floor(offset / 7) * heatStep}" y="${heatLabelHeight - 6}">${escapeHtml(formatCivilDate(point.date))}</text>`
		})
		.join('')
	const width = heatLabelWidth + columns * heatStep
	const height = heatLabelHeight + 7 * heatStep
	return `<div class="heatmap"><h3 id="heatmap-title">Overall day-by-day</h3><svg class="heatmap-chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="heatmap-title heatmap-desc"><desc id="heatmap-desc">Calendar heatmap of globally unioned overall working minutes. Columns are Monday-started weeks; the trend data table below lists every value.</desc>${weekdayLabels}${monthLabels}${cells}</svg><ul class="heat-scale"><li>Less</li><li><span class="heat-swatch heat-0" aria-hidden="true"></span></li><li><span class="heat-swatch heat-1" aria-hidden="true"></span></li><li><span class="heat-swatch heat-2" aria-hidden="true"></span></li><li><span class="heat-swatch heat-3" aria-hidden="true"></span></li><li><span class="heat-swatch heat-4" aria-hidden="true"></span></li><li>More · busiest ${formatMinutes(busiest)}</li></ul></div>`
}

function renderTrendData(trend: Trend): string {
	const plotTop = 20
	const plotBottom = chartHeight - 60
	const plotLeft = 62
	const plotRight = chartWidth - 96
	const allPoints = trend.series.flatMap((series) => series.points)
	const maximum = Math.max(1, ...allPoints.map((point) => point.minutes))
	const pointCount = Math.max(2, ...trend.series.map((series) => series.points.length))
	const positionOf = (index: number, minutes: number) => ({
		x: plotLeft + (index / (pointCount - 1)) * (plotRight - plotLeft),
		y: plotTop + (1 - minutes / maximum) * (plotBottom - plotTop),
	})
	const lines = trend.series
		.map((series, index) => {
			const points = series.points
				.map((point, pointIndex) => {
					const { x, y } = positionOf(pointIndex, point.minutes)
					return `${x.toFixed(2)},${y.toFixed(2)}`
				})
				.join(' ')
			return `<polyline points="${points}" class="trend-line series-${index % 4}" vector-effect="non-scaling-stroke"><title>${escapeHtml(series.kind)}: ${escapeHtml(series.label)}</title></polyline>`
		})
		.join('')
	const endpoints = trend.series
		.map((series, index) => {
			const last = series.points.at(-1)
			if (!last) return ''
			const { x, y } = positionOf(series.points.length - 1, last.minutes)
			const value = formatMinutes(last.minutes)
			const tagWidth = Math.max(46, value.length * 9 + 12)
			return `<circle class="trend-dot series-${index % 4}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5"></circle><rect class="trend-tag" x="${(x + 9).toFixed(2)}" y="${(y - 12).toFixed(2)}" width="${tagWidth}" height="24" rx="7"></rect><text class="trend-tag-text" x="${(x + 15).toFixed(2)}" y="${(y + 5).toFixed(2)}">${value}</text>`
		})
		.join('')
	const axes = [maximum, Math.round(maximum / 2), 0]
		.map((minutes, index) => {
			const y = plotTop + index * ((plotBottom - plotTop) / 2)
			return `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" class="chart-grid"></line><text x="${plotLeft - 8}" y="${y + 5}" text-anchor="end">${formatMinutes(minutes)}</text>`
		})
		.join('')
	const dateLabels = `<text x="${plotLeft}" y="${chartHeight - 18}" text-anchor="start">${escapeHtml(trend.start_date)}</text><text x="${plotRight}" y="${chartHeight - 18}" text-anchor="end">${escapeHtml(trend.end_date)}</text>`
	const legend = trend.series
		.map(
			(series, index) =>
				`<li><span class="legend-line series-${index % 4}" aria-hidden="true"></span><strong>${escapeHtml(series.kind)}</strong>: ${escapeHtml(series.label)}</li>`,
		)
		.join('')
	const dates = [...new Set(trend.series.flatMap((series) => series.points.map((point) => point.date)))].sort()
	const headings = trend.series
		.map((series) => `<th scope="col">${escapeHtml(series.kind)}: ${escapeHtml(series.label)}</th>`)
		.join('')
	const valuesBySeries = trend.series.map(
		(series) => new Map(series.points.map((point) => [point.date, point.minutes])),
	)
	const rows = dates
		.map(
			(date) =>
				`<tr><th scope="row">${escapeHtml(date)}</th>${valuesBySeries.map((values) => `<td>${values.has(date) ? formatMinutes(values.get(date)!) : 'No data'}</td>`).join('')}</tr>`,
		)
		.join('')
	const overall = trend.series.find((series) => series.kind === 'overall')
	return `<ul class="chart-legend">${legend}</ul><p class="scroll-hint">Scroll the chart horizontally to see the full range.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable daily activity trend"><svg class="trend-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="trend-svg-title trend-svg-desc"><title id="trend-svg-title">Daily activity trend</title><desc id="trend-svg-desc">Separate, non-stacked lines. Series overlap and are not additive. The labelled dot on each line is its most recent day.</desc>${axes}${dateLabels}${lines}${endpoints}</svg></div>${renderHeatmap(overall)}<details><summary>View daily values</summary><p class="guidance">Exact values behind the chart, provided for comparison and as a text alternative.</p><div class="table-scroll"><table><caption>Daily working time by date and series</caption><thead><tr><th scope="col">Date</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div></details>`
}

function renderTrend(panel: DashboardReport['trend'], selection: DashboardSelection): string {
	return `<section aria-labelledby="trend-title"><div class="section-heading"><div><p class="eyebrow">Independent, non-stacked series</p><h2 id="trend-title">Activity trend</h2></div>${renderRange(selection)}</div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTrendData(panel.data)}</section>`
}

/* ---------- Executors ---------- */

function executorCard(executor: ExecutorSummary, timezone: string): string {
	const state =
		executor.credential_state === 'not-applicable'
			? 'Managed workload identity'
			: `Credential ${executor.credential_state}`
	return `<article class="executor-card"><h3>${escapeHtml(executor.label)}</h3><dl><div><dt>Last activity</dt><dd>${formatTimestamp(executor.last_activity_at, timezone)}</dd></div><div><dt>Last synchronized</dt><dd>${formatTimestamp(executor.last_synchronized_at, timezone)}</dd></div><div><dt>Access</dt><dd><span class="credential credential-${executor.credential_state}">${escapeHtml(state)}</span></dd></div></dl></article>`
}

function renderExecutors(panel: DashboardReport['executors'], timezone: string): string {
	return `<section aria-labelledby="executors-title"><div class="section-heading"><div><p class="eyebrow">Operational context, not presence</p><h2 id="executors-title">Executors</h2></div></div><p class="guidance">Last activity is evidence, not an online/offline health signal. Last synchronized records when evidence reached Cukup.</p>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : `<div class="executor-grid">${panel.data.map((executor) => executorCard(executor, timezone)).join('')}</div>`}</section>`
}

/* ---------- Document ---------- */

export function renderDashboardContent(
	report: DashboardReport,
	selection: DashboardSelection,
	refreshing = false,
): string {
	const partial = [report.overall, report.timeline, report.trend, report.executors].some(
		(panel) => panel.state !== 'ready',
	)
	return `<header class="masthead"><div><p class="eyebrow">Personal dashboard</p><div class="wordmark"><h1>Cukup</h1><span class="wordmark-tag">${escapeHtml(report.timezone)}</span></div></div><div class="freshness ${partial ? 'freshness-partial' : ''}"><span class="freshness-mark" aria-hidden="true"></span><span>${partial ? '<strong>Partial report.</strong> ' : ''}Authoritative as of <time datetime="${escapeHtml(report.as_of)}">${formatTimestamp(report.as_of, report.timezone)}</time></span><span class="sr-only" role="status" aria-live="polite">${refreshing ? 'Refreshing dashboard' : partial ? 'Dashboard has stale or unavailable panels' : 'Dashboard up to date'}</span></div></header><main>${renderOverall(report.overall)}${renderFilters(report, selection, refreshing)}${renderTimeline(report.timeline, report.timezone)}${renderTrend(report.trend, selection)}${renderExecutors(report.executors, report.timezone)}</main><footer class="page-footer"><p>Cukup reports Working Time, never prompts or content. Filtered activity is targetless and non-additive.</p></footer>`
}

export function renderDashboardDocument(
	report: DashboardReport,
	selection: DashboardSelection,
	nonce?: string,
): string {
	const serialized = JSON.stringify({ report, selection }).replaceAll('<', '\\u003c')
	const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : ''
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Cukup dashboard</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><form class="session-actions" method="post" action="/logout"><button type="submit">Sign out</button></form><div id="dashboard-app">${renderDashboardContent(report, selection)}</div><script id="dashboard-data" type="application/json"${nonceAttribute}>${serialized}</script><script type="module" src="/assets/dashboard.js"></script></body></html>`
}
