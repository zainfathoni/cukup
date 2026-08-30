import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkHoursStore } from './store.ts'

const temporaryDirectories: string[] = []

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'amp-work-hours-test-'))
	temporaryDirectories.push(directory)
	return join(directory, 'nested', 'state.sqlite')
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('WorkHoursStore', () => {
	test('persists events idempotently across store instances', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 999 })
		first.close()

		const reopened = new WorkHoursStore(path)
		expect(reopened.events()).toEqual([
			{ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 },
		])
		reopened.close()
	})

	test('supports interleaved writes from multiple SQLite connections', () => {
		const path = databasePath()
		const first = new WorkHoursStore(path)
		const second = new WorkHoursStore(path)
		first.record({ threadId: 'T-one', messageId: '1', kind: 'start', atMs: 100 })
		second.record({ threadId: 'T-two', messageId: '2', kind: 'start', atMs: 200 })
		first.record({
			threadId: 'T-one',
			messageId: '1',
			kind: 'end',
			atMs: 300,
			status: 'done',
		})
		expect(second.events()).toHaveLength(3)
		first.close()
		second.close()
	})

	test('stores the weekday target and falls back to eight hours', () => {
		const store = new WorkHoursStore(databasePath())
		expect(store.weekdayTargetMinutes()).toBe(480)
		store.setWeekdayTargetMinutes(450)
		expect(store.weekdayTargetMinutes()).toBe(450)
		expect(() => store.setWeekdayTargetMinutes(1441)).toThrow()
		store.close()
	})

	test('restricts state directory and database permissions', () => {
		const path = databasePath()
		const directory = join(path, '..')
		chmodSync(join(directory, '..'), 0o755)
		const store = new WorkHoursStore(path)
		expect(statSync(directory).mode & 0o777).toBe(0o700)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		store.close()
	})
})
