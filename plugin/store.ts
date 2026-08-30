import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_WEEKDAY_TARGET_MINUTES, type WorkEvent } from './tracker.ts'

const targetSetting = 'weekday-target-minutes'

export function defaultDatabasePath(): string {
	const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
	return join(stateHome, 'amp-work-hours', 'state.sqlite')
}

export class WorkHoursStore {
	readonly #database: Database

	constructor(path = defaultDatabasePath()) {
		const directory = dirname(path)
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
		this.#database = new Database(path, { create: true, strict: true })
		chmodSync(path, 0o600)
		this.#database.exec('PRAGMA busy_timeout = 5000')
		this.#database.exec('PRAGMA journal_mode = WAL')
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS events (
				event_key TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
				at_ms INTEGER NOT NULL,
				status TEXT CHECK (status IS NULL OR status IN ('done', 'error', 'cancelled'))
			);
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`)
	}

	record(event: WorkEvent): void {
		const write = this.#database.transaction((value: WorkEvent) => {
			this.#database
				.query(
					`INSERT OR IGNORE INTO events
						(event_key, thread_id, message_id, kind, at_ms, status)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					`${value.threadId}\u0000${value.messageId}\u0000${value.kind}`,
					value.threadId,
					value.messageId,
					value.kind,
					value.atMs,
					value.status ?? null,
				)
		})
		write(event)
	}

	events(): WorkEvent[] {
		return this.#database
			.query<
				{
					threadId: string
					messageId: string
					kind: 'start' | 'end'
					atMs: number
					status: 'done' | 'error' | 'cancelled' | null
				},
				[]
			>(
				`SELECT thread_id AS threadId, message_id AS messageId, kind, at_ms AS atMs, status
				 FROM events ORDER BY at_ms, event_key`,
			)
			.all()
			.map((row) => ({
				threadId: row.threadId,
				messageId: row.messageId,
				kind: row.kind,
				atMs: row.atMs,
				...(row.status ? { status: row.status } : {}),
			}))
	}

	weekdayTargetMinutes(): number {
		const row = this.#database
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(targetSetting)
		const value = row ? Number(row.value) : DEFAULT_WEEKDAY_TARGET_MINUTES
		return Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60
			? value
			: DEFAULT_WEEKDAY_TARGET_MINUTES
	}

	setWeekdayTargetMinutes(minutes: number): void {
		if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
			throw new Error('Daily target must be a whole number of minutes from 0:00 to 24:00.')
		}
		this.#database
			.query(
				`INSERT INTO settings (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.run(targetSetting, String(minutes))
	}

	close(): void {
		this.#database.close()
	}
}
