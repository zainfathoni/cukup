import type {
	DashboardReport,
	DashboardSelection,
	DayBreakdown,
	DayDetail,
	ExecutorSummary,
	Panel,
	TargetPeriod,
	Timeline,
	TimelineLane,
	Trend,
} from './report.ts'

const chartWidth = 960
const chartHeight = 260
const meterWidth = 480
const meterHeight = 34

/* Gantt geometry, in viewBox units. The label gutter holds a truncated lane
   name and its right-aligned total, so the plot always starts at one x. */
const laneGutter = 200
const laneLabelChars = 17
const ganttRight = chartWidth - 16
const ganttTopAxis = 26
const ganttBottomAxis = 26
const unionRowHeight = 34
const laneRowHeight = 24
const groupRowHeight = 24

/**
 * Half the hover card width, used to pick which edge it anchors to. It tracks
 * `.heat-tip`'s `17rem` at the default root size; a much larger root font would
 * widen the card past this and let a near-edge day spill sideways.
 */
const tipReach = 136

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

/**
 * This module is bundled into the browser client and re-runs on every refresh,
 * and a long range renders thousands of timestamps, so formatters are built
 * once per timezone and reused.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${timezone}\u0000${Object.values(options).join('|')}`
	let formatter = formatters.get(key)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, ...options })
		formatters.set(key, formatter)
	}
	return formatter
}

function formatMinutes(minutes: number): string {
	const hours = Math.floor(minutes / 60)
	const remainder = minutes % 60
	return hours === 0 ? `${remainder}m` : `${hours}h ${remainder}m`
}

function formatTimestamp(value: string | null, timezone: string): string {
	if (value === null) return 'No activity recorded'
	return formatterFor(timezone, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

/** Zoned wall-clock `HH:mm`, the only time detail a same-day chart needs. */
function formatClock(value: string, timezone: string): string {
	return formatterFor(timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
		new Date(value),
	)
}

function formatCivilDate(date: string): string {
	const parsed = Date.parse(`${date}T00:00:00Z`)
	if (!Number.isFinite(parsed)) return date
	return formatterFor('UTC', { day: 'numeric', month: 'short' }).format(new Date(parsed))
}

function formatCivilMonth(date: string): string {
	const parsed = Date.parse(`${date}T00:00:00Z`)
	if (!Number.isFinite(parsed)) return date
	return formatterFor('UTC', { month: 'short' }).format(new Date(parsed))
}

function formatCivilDay(date: string): string {
	const parsed = Date.parse(`${date}T00:00:00Z`)
	if (!Number.isFinite(parsed)) return date
	return formatterFor('UTC', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	}).format(new Date(parsed))
}

/** Trims a lane name to the gutter budget without an SVG text overflow. */
function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}\u2026`
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
function verdictMeter(
	period: Pick<TargetPeriod, 'worked_minutes' | 'target_minutes'>,
	label: string,
): string {
	const scale = Math.max(period.worked_minutes, period.target_minutes, 1) * 1.1
	const inner = meterWidth - 4
	const worked = Math.max(0, Math.min(inner, (period.worked_minutes / scale) * inner))
	const targetX = 2 + (period.target_minutes / scale) * inner
	const description = `${formatMinutes(period.worked_minutes)} worked against target ${formatMinutes(period.target_minutes)}`
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
		<div class="section-heading"><div><p class="eyebrow">Filtered activity view</p><h2 id="filters-title">Filters</h2></div><button type="button" class="button" data-action="refresh" data-focus-key="refresh" ${refreshing ? 'disabled aria-disabled="true"' : ''}>${refreshing ? 'Refreshing…' : 'Refresh now'}</button></div>
		<p class="guidance"><strong>Activity is non-additive.</strong> Concurrent project and executor values overlap and must not be added. Multiple values within a filter use OR; project and executor filters combine with AND. Overall Working Time above never changes.</p>
		<div class="filter-grid">${filterGroup('Projects', 'projects', report.available_projects, selection.projects)}${filterGroup('Executors', 'executors', report.available_executors, selection.executors)}</div>
	</section>`
}

/* ---------- Timeline ---------- */

function zonedMinute(value: string, timezone: string): number {
	const parts = formatterFor(timezone, {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(value))
	const part = (type: 'hour' | 'minute') => Number(parts.find((item) => item.type === type)?.value ?? 0)
	return part('hour') * 60 + part('minute')
}

function zonedCivilDate(value: string, timezone: string): string {
	const parts = formatterFor(timezone, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(new Date(value))
	const part = (type: 'year' | 'month' | 'day') => parts.find((item) => item.type === type)?.value ?? ''
	return `${part('year')}-${part('month')}-${part('day')}`
}

type GanttRow =
	| { kind: 'union' }
	| { kind: 'group'; label: string }
	| { kind: 'lane'; lane: TimelineLane }

function ganttRows(lanes: readonly TimelineLane[]): GanttRow[] {
	const rows: GanttRow[] = [{ kind: 'union' }]
	for (const [kind, heading] of [
		['project', 'By project'],
		['executor', 'By executor'],
	] as const) {
		const group = lanes.filter((lane) => lane.kind === kind)
		if (group.length === 0) continue
		rows.push({ kind: 'group', label: heading })
		for (const lane of group) rows.push({ kind: 'lane', lane })
	}
	return rows
}

function rowHeight(row: GanttRow): number {
	if (row.kind === 'union') return unionRowHeight
	return row.kind === 'group' ? groupRowHeight : laneRowHeight
}

/** Rounded bar spanning one interval of the zoned day. */
function ganttBar(
	start: string,
	end: string,
	top: number,
	height: number,
	className: string,
	title: string,
	timezone: string,
): string {
	const plotWidth = ganttRight - laneGutter
	const startMinute = zonedMinute(start, timezone)
	const endMinute = Math.max(startMinute + 1, zonedMinute(end, timezone))
	const x = laneGutter + (startMinute / 1440) * plotWidth
	const width = Math.max(3, ((endMinute - startMinute) / 1440) * plotWidth)
	return `<rect class="${className}" x="${x.toFixed(2)}" y="${top}" width="${width.toFixed(2)}" height="${height}" rx="4"><title>${escapeHtml(title)}</title></rect>`
}

function renderGantt(timeline: Timeline, timezone: string, asOf: string): string {
	const rows = ganttRows(timeline.lanes)
	const plotTop = ganttTopAxis
	const plotWidth = ganttRight - laneGutter
	const tops: number[] = []
	let cursor = plotTop
	for (const row of rows) {
		tops.push(cursor)
		cursor += rowHeight(row)
	}
	const plotHeight = Math.max(cursor - plotTop, unionRowHeight)
	const height = plotTop + plotHeight + ganttBottomAxis
	const minuteX = (minute: number) => laneGutter + (minute / 1440) * plotWidth

	const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24]
	const gridlines = hours
		.map(
			(hour) =>
				`<line class="chart-grid" x1="${minuteX(hour * 60).toFixed(2)}" y1="${plotTop}" x2="${minuteX(hour * 60).toFixed(2)}" y2="${plotTop + plotHeight}"></line>`,
		)
		.join('')
	const ticks = hours
		.map(
			(hour) =>
				`<text x="${minuteX(hour * 60).toFixed(2)}" y="${plotTop - 8}" text-anchor="${hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'}">${String(hour).padStart(2, '0')}:00</text>`,
		)
		.join('')
	const baseline = `<line class="gantt-axis" x1="${laneGutter}" y1="${plotTop + plotHeight}" x2="${ganttRight}" y2="${plotTop + plotHeight}"></line>`

	// Everything right of the current minute is unobserved rather than idle.
	const sameDay = zonedCivilDate(asOf, timezone) === timeline.date
	const nowMinute = sameDay ? zonedMinute(asOf, timezone) : 1440
	const future =
		nowMinute >= 1440
			? ''
			: `<rect class="gantt-future" x="${minuteX(nowMinute).toFixed(2)}" y="${plotTop}" width="${(ganttRight - minuteX(nowMinute)).toFixed(2)}" height="${plotHeight}"></rect><line class="gantt-now" x1="${minuteX(nowMinute).toFixed(2)}" y1="${plotTop - 4}" x2="${minuteX(nowMinute).toFixed(2)}" y2="${plotTop + plotHeight}"><title>Now, ${escapeHtml(formatClock(asOf, timezone))}</title></line><text class="gantt-now-label" x="${minuteX(nowMinute).toFixed(2)}" y="${plotTop + plotHeight + 17}" text-anchor="middle">now</text>`

	const body = rows
		.map((row, index) => {
			const top = tops[index]!
			if (row.kind === 'group') {
				return `<text class="gantt-group" x="0" y="${top + 16}">${escapeHtml(row.label)}</text>`
			}
			const stripe = `<rect class="gantt-track" x="${laneGutter}" y="${top + 2}" width="${plotWidth}" height="${rowHeight(row) - 4}" rx="4"></rect>`
			if (row.kind === 'union') {
				const bars = timeline.intervals
					.map((interval) =>
						ganttBar(
							interval.start,
							interval.end,
							top + 8,
							unionRowHeight - 16,
							`gantt-bar gantt-union concurrency-${Math.min(interval.concurrency, 2)}`,
							`${formatClock(interval.start, timezone)}–${formatClock(interval.end, timezone)}; concurrency ${interval.concurrency}`,
							timezone,
						),
					)
					.join('')
				return `${stripe}<text class="gantt-label gantt-union-label" x="0" y="${top + 22}">All selected</text><text class="gantt-total" x="${laneGutter - 12}" y="${top + 22}" text-anchor="end">${formatMinutes(timeline.minutes)}</text>${bars}`
			}
			const bars = row.lane.intervals
				.map((interval) =>
					ganttBar(
						interval.start,
						interval.end,
						top + 6,
						laneRowHeight - 12,
						`gantt-bar gantt-${row.lane.kind}`,
						`${row.lane.label}: ${formatClock(interval.start, timezone)}–${formatClock(interval.end, timezone)}`,
						timezone,
					),
				)
				.join('')
			return `${stripe}<text class="gantt-label" x="0" y="${top + 16}">${escapeHtml(truncate(row.lane.label, laneLabelChars))}<title>${escapeHtml(row.lane.label)}</title></text><text class="gantt-total" x="${laneGutter - 12}" y="${top + 16}" text-anchor="end">${formatMinutes(row.lane.minutes)}</text>${bars}`
		})
		.join('')

	const empty =
		timeline.intervals.length === 0
			? `<text class="gantt-empty" x="${(laneGutter + plotWidth / 2).toFixed(2)}" y="${(plotTop + plotHeight / 2 + 5).toFixed(2)}" text-anchor="middle">No activity recorded yet today</text>`
			: ''

	return `<svg class="gantt-chart" viewBox="0 0 ${chartWidth} ${height}" role="img" aria-labelledby="timeline-svg-title timeline-svg-desc"><title id="timeline-svg-title">Current-day activity timeline</title><desc id="timeline-svg-desc">Gantt lanes across a 24-hour ${escapeHtml(timezone)} day. The top lane is every selected interval unioned, shaded where raw evidence was concurrent. Below it, one lane per project and one lane per executor: bars are unioned within a lane, so overlap is only visible where bars in different lanes line up vertically. Project and executor lanes describe the same time and must not be added. The daily table below lists every value.</desc><rect class="gantt-plot" x="${laneGutter}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" rx="6"></rect>${gridlines}${future}${body}${empty}${baseline}${ticks}</svg>`
}

function laneEquivalent(lanes: readonly TimelineLane[], kind: TimelineLane['kind'], timezone: string): string {
	const group = lanes.filter((lane) => lane.kind === kind)
	if (group.length === 0) return ''
	const heading = kind === 'project' ? 'By project' : 'By executor'
	const items = group
		.map(
			(lane) =>
				`<li><strong>${escapeHtml(lane.label)}</strong> · ${formatMinutes(lane.minutes)} · ${lane.intervals
					.map((interval) => `${formatClock(interval.start, timezone)}–${formatClock(interval.end, timezone)}`)
					.join(', ')}</li>`,
		)
		.join('')
	return `<h4>${heading}</h4><ul class="text-equivalent">${items}</ul>`
}

function renderTimelineData(timeline: Timeline, timezone: string, asOf: string): string {
	const equivalents = timeline.intervals.length
		? `<ol class="text-equivalent">${timeline.intervals.map((interval) => `<li>${formatTimestamp(interval.start, timezone)}–${formatTimestamp(interval.end, timezone)}; concurrency ${interval.concurrency}</li>`).join('')}</ol>`
		: '<p>No activity intervals recorded today.</p>'
	return `<div class="verdict-grid activity-period-grid">${verdictCard('Selected day', timeline.day_period)}${verdictCard('Selected ISO week', timeline.week_period)}</div><p class="guidance">Timeline worked totals follow the Project and Executor filters. The targets are the overall configured targets for ${escapeHtml(timeline.date)} and its full Monday–Sunday ${escapeHtml(timeline.week)} week, not separate project or executor quotas.</p><ul class="chart-legend"><li><span class="block-swatch" aria-hidden="true"></span>Single-source evidence</li><li><span class="block-swatch concurrent" aria-hidden="true"></span>Concurrent evidence</li><li><span class="block-swatch project" aria-hidden="true"></span>Project lane</li><li><span class="block-swatch executor" aria-hidden="true"></span>Executor lane</li></ul><p class="guidance">Lanes share one clock. Bars are unioned inside a lane, so a project lane and an executor lane that line up vertically describe the same minutes and must not be added.</p><p class="scroll-hint">Scroll the chart horizontally to see the full day.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable current-day timeline">${renderGantt(timeline, timezone, asOf)}</div><details><summary>Timeline text equivalent</summary><h4>All selected activity</h4>${equivalents}${laneEquivalent(timeline.lanes, 'project', timezone)}${laneEquivalent(timeline.lanes, 'executor', timezone)}</details>`
}

function renderTimeline(panel: DashboardReport['timeline'], timezone: string, asOf: string): string {
	return `<section aria-labelledby="timeline-title"><div class="section-heading"><div><p class="eyebrow">Selected day · ${escapeHtml(timezone)}</p><h2 id="timeline-title" tabindex="-1">Activity timeline</h2></div></div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTimelineData(panel.data, timezone, asOf)}</section>`
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

function breakdownLine(entries: readonly DayBreakdown[]): string {
	if (entries.length === 0) return 'None recorded'
	const shown = entries.slice(0, 3).map((entry) => `${escapeHtml(entry.label)} ${formatMinutes(entry.minutes)}`)
	const remaining = entries.length - shown.length
	return [...shown, ...(remaining > 0 ? [`+${remaining} more`] : [])].join(' · ')
}

function breakdownText(entries: readonly DayBreakdown[]): string {
	if (entries.length === 0) return 'None recorded'
	return entries.map((entry) => `${escapeHtml(entry.label)} ${formatMinutes(entry.minutes)}`).join('; ')
}

function activitySpan(day: DayDetail, timezone: string): string | null {
	if (day.first_activity_at === null || day.last_activity_at === null) return null
	return `${formatClock(day.first_activity_at, timezone)}–${formatClock(day.last_activity_at, timezone)}`
}

/** Inspectable detail for one heatmap cell: the day's verdict, then what it was made of. */
function dayCard(day: DayDetail, timezone: string): string {
	const period = day.period
	const caption =
		period.status === 'UNDER'
			? `${formatMinutes(period.difference_minutes)} remaining`
			: period.status === 'OVER'
				? `${formatMinutes(period.difference_minutes)} over`
				: 'target met'
	const span = activitySpan(day, timezone)
	const body =
		period.worked_minutes === 0
			? '<p class="tip-empty">No working time recorded.</p>'
			: `<dl class="tip-breakdown"><div><dt>Projects</dt><dd>${breakdownLine(day.projects)}</dd></div><div><dt>Executors</dt><dd>${breakdownLine(day.executors)}</dd></div></dl><p class="tip-meta">${day.interval_count} interval${day.interval_count === 1 ? '' : 's'}${span === null ? '' : ` · ${escapeHtml(span)}`}</p><p class="tip-note">Activity overlaps; never add it up.</p>`
	return `<p class="tip-date">${escapeHtml(formatCivilDay(day.date))}</p><p class="tip-total"><span class="tip-figure">${formatMinutes(period.worked_minutes)}</span><span class="tip-stamp">${period.status}</span></p><p class="tip-target">Target ${formatMinutes(period.target_minutes)} · ${caption}</p>${body}`
}

/**
 * Calendar heatmap of the globally unioned Overall series, as a CSS grid so a
 * hovered or focused day can open a detail card and selection can drive the
 * timeline. Columns are Monday-started weeks and intensity is quartered against
 * the busiest day. The daily values table carries the same numbers.
 */
function renderHeatmap(days: readonly DayDetail[], timezone: string, selectedDate?: string): string {
	if (days.length === 0) return ''
	const first = weekdayIndex(days[0]!.date)
	if (first === null) return ''
	const busiest = Math.max(1, ...days.map((day) => day.period.worked_minutes))
	const columns = Math.ceil((first + days.length) / 7)
	const [density, columnStep] =
		columns <= 14
			? (['heat-roomy', 24] as const)
			: columns <= 27
				? (['heat-medium', 18] as const)
				: columns <= 40
					? (['heat-compact', 15] as const)
					: (['heat-dense', 12] as const)
	const pads = '<li class="heat-pad"></li>'.repeat(first)
	const cells = days
		.map((day, index) => {
			const column = Math.floor((first + index) / 7)
			// A centred card needs half its width on each side, so columns nearer
			// than that to an edge anchor to it instead.
			const anchor =
				column * columnStep < tipReach
					? ' tip-start'
					: (columns - 1 - column) * columnStep < tipReach
						? ' tip-end'
						: ''
			const minutes = day.period.worked_minutes
			const level = minutes === 0 ? 0 : Math.min(4, Math.ceil((minutes / busiest) * 4))
			const selected = day.date === selectedDate
			return `<li><button type="button" class="heat-cell heat-${level}${selected ? ' heat-selected' : ''}" data-timeline-date="${escapeHtml(day.date)}" data-focus-key="timeline:${escapeHtml(day.date)}" aria-pressed="${selected}" aria-label="Inspect ${escapeHtml(formatCivilDay(day.date))} in the activity timeline"></button><div class="heat-tip status-${day.period.status.toLowerCase()}${anchor}" aria-hidden="true">${dayCard(day, timezone)}</div></li>`
		})
		.join('')
	const monthLabels: string[] = []
	let labelled = ''
	for (let column = 0; column < columns; column += 1) {
		const day = days[Math.max(0, column * 7 - first)]
		const month = day === undefined ? '' : formatCivilMonth(day.date)
		monthLabels.push(month === labelled ? '<li></li>' : `<li>${escapeHtml(month)}</li>`)
		if (month !== labelled) labelled = month
	}
	const weekdays = ['Mon', '', 'Wed', '', 'Fri', '', '']
		.map((label) => `<li>${label}</li>`)
		.join('')
	const summary = `Calendar heatmap of globally unioned overall working minutes from ${days[0]!.date} to ${days.at(-1)!.date}. Busiest day ${formatMinutes(busiest)}. Every value is listed in the daily values table below.`
	return `<div class="heatmap"><div class="heatmap-heading"><h3 id="heatmap-title">Overall day-by-day</h3><p class="heatmap-hint">Hover for detail · select a day to inspect its timeline.</p></div><div class="heat-scroll"><div class="heat-board ${density}"><div class="heat-corner"></div><ol class="heat-months" aria-hidden="true">${monthLabels.join('')}</ol><ul class="heat-weekdays" aria-hidden="true">${weekdays}</ul><ol class="heat-grid" aria-label="${escapeHtml(summary)}">${pads}${cells}</ol></div></div><ul class="heat-scale"><li>Less</li><li><span class="heat-swatch heat-0" aria-hidden="true"></span></li><li><span class="heat-swatch heat-1" aria-hidden="true"></span></li><li><span class="heat-swatch heat-2" aria-hidden="true"></span></li><li><span class="heat-swatch heat-3" aria-hidden="true"></span></li><li><span class="heat-swatch heat-4" aria-hidden="true"></span></li><li>More · busiest ${formatMinutes(busiest)}</li></ul></div>`
}

function renderTrendData(trend: Trend, timezone: string, selectedDate?: string): string {
	const plotTop = 20
	const plotBottom = chartHeight - 60
	const plotLeft = 62
	const plotRight = chartWidth - 96
	const allPoints = trend.series.flatMap((series) => series.points)
	const maximum = Math.max(1, ...allPoints.map((point) => point.minutes))
	const dates = [...new Set(trend.series.flatMap((series) => series.points.map((point) => point.date)))].sort()
	const dateIndex = new Map(dates.map((date, index) => [date, index]))
	const pointCount = Math.max(2, dates.length)
	const positionOf = (index: number, minutes: number) => ({
		x: plotLeft + (index / (pointCount - 1)) * (plotRight - plotLeft),
		y: plotTop + (1 - minutes / maximum) * (plotBottom - plotTop),
	})
	const lines = trend.series
		.map((series, index) => {
			const points = series.points
				.map((point, pointIndex) => {
					const { x, y } = positionOf(dateIndex.get(point.date) ?? pointIndex, point.minutes)
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
			const { x, y } = positionOf(dateIndex.get(last.date) ?? series.points.length - 1, last.minutes)
			const value = formatMinutes(last.minutes)
			const tagWidth = Math.max(46, value.length * 9 + 12)
			return `<circle class="trend-dot series-${index % 4}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5"></circle><rect class="trend-tag" x="${(x + 9).toFixed(2)}" y="${(y - 12).toFixed(2)}" width="${tagWidth}" height="24" rx="7"></rect><text class="trend-tag-text" x="${(x + 15).toFixed(2)}" y="${(y + 5).toFixed(2)}">${value}</text>`
		})
		.join('')
	const hoverTargets = dates
		.map((date, datePosition) => {
			const x = positionOf(datePosition, 0).x
			const left = datePosition === 0 ? plotLeft : (positionOf(datePosition - 0.5, 0).x + x) / 2
			const right = datePosition === dates.length - 1 ? plotRight : (x + positionOf(datePosition + 0.5, 0).x) / 2
			const values = trend.series
				.map((series, seriesIndex) => {
					const point = series.points.find((candidate) => candidate.date === date)
					if (!point) return ''
					const { y } = positionOf(datePosition, point.minutes)
					const value = formatMinutes(point.minutes)
					const tagWidth = Math.max(46, value.length * 9 + 12)
					const tagY = Math.max(plotTop, Math.min(plotBottom - 24, y - 12))
					return `<circle class="trend-hover-dot series-${seriesIndex % 4}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5"></circle><rect class="trend-hover-tag series-${seriesIndex % 4}" x="${(x + 9).toFixed(2)}" y="${tagY.toFixed(2)}" width="${tagWidth}" height="24" rx="7"></rect><text class="trend-hover-tag-text" x="${(x + 15).toFixed(2)}" y="${(tagY + 17).toFixed(2)}">${value}</text>`
				})
				.join('')
			const label = trend.series
				.map((series) => {
					const point = series.points.find((candidate) => candidate.date === date)
					return point === undefined ? null : `${series.kind} ${series.label}: ${formatMinutes(point.minutes)}`
				})
				.filter((entry): entry is string => entry !== null)
				.join(', ')
			return `<g class="trend-hover" tabindex="0" aria-label="${escapeHtml(`${date}: ${label}`)}"><title>${escapeHtml(`${date}: ${label}`)}</title><rect class="trend-hit" x="${left.toFixed(2)}" y="${plotTop}" width="${(right - left).toFixed(2)}" height="${plotBottom - plotTop}"></rect><line class="trend-hover-line" x1="${x.toFixed(2)}" y1="${plotTop}" x2="${x.toFixed(2)}" y2="${plotBottom}"></line>${values}</g>`
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
	const details = new Map(trend.days.map((day) => [day.date, day]))
	const headings = trend.series
		.map((series) => `<th scope="col">${escapeHtml(series.kind)}: ${escapeHtml(series.label)}</th>`)
		.join('')
	const valuesBySeries = trend.series.map(
		(series) => new Map(series.points.map((point) => [point.date, point.minutes])),
	)
	const rows = dates
		.map((date) => {
			const day = details.get(date)
			const detailCells =
				day === undefined
					? '<td>No data</td><td>No data</td><td>No data</td><td>No data</td><td>No data</td><td>No data</td>'
					: `<td>${formatMinutes(day.period.target_minutes)}</td><td>${day.period.status}</td><td>${day.interval_count}</td><td>${escapeHtml(activitySpan(day, timezone) ?? 'No activity')}</td><td>${breakdownText(day.projects)}</td><td>${breakdownText(day.executors)}</td>`
			return `<tr><th scope="row">${escapeHtml(date)}</th>${valuesBySeries.map((values) => `<td>${values.has(date) ? formatMinutes(values.get(date)!) : 'No data'}</td>`).join('')}${detailCells}</tr>`
		})
		.join('')
	return `<ul class="chart-legend">${legend}</ul><p class="scroll-hint">Scroll the chart horizontally to see the full range.</p><div class="chart-scroll" tabindex="0" role="region" aria-label="Scrollable daily activity trend"><svg class="trend-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="trend-svg-title trend-svg-desc"><title id="trend-svg-title">Daily activity trend</title><desc id="trend-svg-desc">Separate, non-stacked lines. Series overlap and are not additive. Hover or focus a day to see that day’s value on every line. The labelled dot on each line is its most recent day.</desc>${axes}${dateLabels}${lines}${endpoints}${hoverTargets}</svg></div>${renderHeatmap(trend.days, timezone, selectedDate)}<details><summary>View daily values</summary><p class="guidance">Exact values behind the chart, provided for comparison and as a text alternative. Target, status, intervals, and the activity breakdown describe the globally unioned Overall series; project and executor activity overlap and must not be added.</p><div class="table-scroll"><table><caption>Daily working time by date and series</caption><thead><tr><th scope="col">Date</th>${headings}<th scope="col">Target</th><th scope="col">Status</th><th scope="col">Intervals</th><th scope="col">First–last</th><th scope="col">Project activity</th><th scope="col">Executor activity</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
}

function renderTrend(
	panel: DashboardReport['trend'],
	selection: DashboardSelection,
	timezone: string,
): string {
	return `<section aria-labelledby="trend-title"><div class="section-heading"><div><p class="eyebrow">Independent, non-stacked series</p><h2 id="trend-title">Activity trend</h2></div>${renderRange(selection)}</div>${panelNotice(panel)}${panel.state === 'unavailable' ? '' : renderTrendData(panel.data, timezone, selection.timeline_date)}</section>`
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
	return `<header class="masthead"><div><p class="eyebrow">Personal dashboard</p><div class="wordmark"><h1>Cukup</h1><span class="wordmark-tag">${escapeHtml(report.timezone)}</span></div></div><div class="freshness ${partial ? 'freshness-partial' : ''}"><span class="freshness-mark" aria-hidden="true"></span><span>${partial ? '<strong>Partial report.</strong> ' : ''}Authoritative as of <time datetime="${escapeHtml(report.as_of)}">${formatTimestamp(report.as_of, report.timezone)}</time></span><span class="sr-only" role="status" aria-live="polite">${refreshing ? 'Refreshing dashboard' : partial ? 'Dashboard has stale or unavailable panels' : 'Dashboard up to date'}</span></div></header><main>${renderOverall(report.overall)}${renderFilters(report, selection, refreshing)}${renderTimeline(report.timeline, report.timezone, report.as_of)}${renderTrend(report.trend, selection, report.timezone)}${renderExecutors(report.executors, report.timezone)}</main><footer class="page-footer"><p>Cukup reports Working Time, never prompts or content. Filtered activity is non-additive; timeline targets are overall configured benchmarks, not filtered quotas.</p></footer>`
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
