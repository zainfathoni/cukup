export type LogSink = (line: string) => void

const sensitiveKey =
	/authorization|cookie|credential|token|jwt|claims?|user_id|thread_id|event_id|source_instance|session_id|project_slug|projects?|executor_label|executors?|labels?|oauth_code|report|request_body/i
const bearerValue = /Bearer\s+[^\s"']+/gi
const cukupToken = /cukup_v1_[A-Za-z0-9_-]+/g
const jwtValue = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

export class ServiceLogger {
	readonly #sink: LogSink

	constructor(sink: LogSink = console.log) {
		this.#sink = sink
	}

	info(event: string, fields: Record<string, unknown>): void {
		this.#write('info', event, fields)
	}

	error(event: string, fields: Record<string, unknown>): void {
		this.#write('error', event, fields)
	}

	#write(level: 'info' | 'error', event: string, fields: Record<string, unknown>): void {
		this.#sink(JSON.stringify(redactSensitive({ level, event, ...fields })))
	}
}

export function redactSensitive(value: unknown, key = ''): unknown {
	if (sensitiveKey.test(key)) return '[REDACTED]'
	if (typeof value === 'string') return redactString(value)
	if (Array.isArray(value)) return value.map((item) => redactSensitive(item))
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([nestedKey, nestedValue]) => [
				nestedKey,
				redactSensitive(nestedValue, nestedKey),
			]),
		)
	}
	return value
}

function redactString(value: string): string {
	return value
		.replace(bearerValue, 'Bearer [REDACTED]')
		.replace(cukupToken, '[REDACTED]')
		.replace(jwtValue, '[REDACTED]')
}
