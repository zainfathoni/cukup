import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CukupServiceClient } from '../plugin/protocol.ts'
import { WorkHoursStore } from '../plugin/store.ts'
import { SyncEngine } from '../plugin/sync.ts'
import { createApp } from './app.ts'
import { ServiceLogger } from './logger.ts'
import { ServiceStore } from './store.ts'

/**
 * A credential-free local plugin/service integration stack.
 *
 * It exercises the existing plugin-to-service boundary without Fleet access,
 * production credentials, DNS, or network egress. Every dependency is explicit:
 *
 * - SQLite lives in a fresh temporary directory that `close()` removes;
 * - the bearer credential is issued by the local service store, never read from
 *   the environment or a token file;
 * - workload OIDC always denies, so no identity provider is contacted;
 * - the clock is injected, so assertions never depend on wall-clock time;
 * - HTTP never leaves the process: the client calls `app.fetch` directly.
 *
 * This module is test-only. It is deliberately not re-exported from any shipped
 * entry point.
 */
export type LocalStack = {
	nowMs: number
	directory: string
	pluginPath: string
	servicePath: string
	pluginStore: WorkHoursStore
	serviceStore: ServiceStore
	/** The bearer token the local service store issued for this stack. */
	token: string
	client: CukupServiceClient
	sync: SyncEngine
	close(): Promise<void>
}

export type LocalStackOptions = {
	/** Injected clock. Defaults to a fixed instant so tests stay deterministic. */
	nowMs?: number
	/**
	 * Seed the plugin database before `WorkHoursStore` opens it, for migration
	 * coverage. Receives the path; the parent directory already exists.
	 */
	seedPluginDatabase?: (pluginPath: string) => void
}

export const LOCAL_STACK_DEFAULT_NOW_MS = Date.parse('2026-08-31T05:00:00.000Z')

export function createLocalStack(options: LocalStackOptions = {}): LocalStack {
	const nowMs = options.nowMs ?? LOCAL_STACK_DEFAULT_NOW_MS
	const now = () => nowMs
	const directory = mkdtempSync(join(tmpdir(), 'cukup-local-stack-'))
	const pluginPath = join(directory, 'plugin', 'state.sqlite')
	const servicePath = join(directory, 'service', 'state.sqlite')
	let pluginStore: WorkHoursStore | undefined
	let serviceStore: ServiceStore | undefined

	try {
		mkdirSync(dirname(pluginPath), { recursive: true })
		options.seedPluginDatabase?.(pluginPath)

		const createdPluginStore = new WorkHoursStore(pluginPath)
		pluginStore = createdPluginStore
		const createdServiceStore = new ServiceStore(servicePath)
		serviceStore = createdServiceStore
		const issued = createdServiceStore.issueBearer(nowMs)
		const app = createApp({
			store: createdServiceStore,
			oidcVerifier: { verify: async () => false },
			now,
			logger: new ServiceLogger(() => {}),
		})
		const client = new CukupServiceClient(
			'https://api.cukup.dev',
			(input, init) => app.fetch(new Request(input, init)),
			now,
		)
		const sync = new SyncEngine({
			store: createdPluginStore,
			client,
			tokenProvider: { getToken: async () => issued.token },
			now,
		})

		return {
			nowMs,
			directory,
			pluginPath,
			servicePath,
			pluginStore: createdPluginStore,
			serviceStore: createdServiceStore,
			token: issued.token,
			client,
			sync,
			async close() {
				try {
					await sync.dispose()
				} finally {
					try {
						createdPluginStore.close()
					} finally {
						try {
							createdServiceStore.close()
						} finally {
							rmSync(directory, { recursive: true, force: true })
						}
					}
				}
			},
		}
	} catch (error) {
		try {
			pluginStore?.close()
		} finally {
			try {
				serviceStore?.close()
			} finally {
				rmSync(directory, { recursive: true, force: true })
			}
		}
		throw error
	}
}
