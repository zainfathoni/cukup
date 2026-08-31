import { createApp } from './app.ts'
import { OidcVerifier } from './auth.ts'
import {
	configuredAllowedOidcUserId,
	configuredFleetHostnames,
	configuredNewTurnEventSchemaVersion,
	defaultServiceDatabasePath,
} from './config.ts'
import { ServiceLogger } from './logger.ts'
import { ServiceStore } from './store.ts'

const hostname = process.env.CUKUP_HOST?.trim() || '127.0.0.1'
const port = parsePort(process.env.PORT)
const behindTlsProxy = process.env.CUKUP_BEHIND_TLS_PROXY === '1'
const certificatePath = process.env.CUKUP_TLS_CERT_PATH?.trim()
const keyPath = process.env.CUKUP_TLS_KEY_PATH?.trim()
const directTls = Boolean(certificatePath && keyPath)
const loopbackOnly = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'

if (Boolean(certificatePath) !== Boolean(keyPath)) {
	throw new Error('Both CUKUP_TLS_CERT_PATH and CUKUP_TLS_KEY_PATH are required for direct TLS')
}
if (!directTls && !behindTlsProxy && !loopbackOnly) {
	throw new Error('Non-loopback service binding requires direct TLS or CUKUP_BEHIND_TLS_PROXY=1')
}

const allowedOidcUserId = configuredAllowedOidcUserId()
const fleetHostnames = configuredFleetHostnames()
const preferredNewEventSchemaVersion = configuredNewTurnEventSchemaVersion()
const store = new ServiceStore(defaultServiceDatabasePath())
const logger = new ServiceLogger()
const app = createApp({
	store,
	oidcVerifier: new OidcVerifier({ allowedUserId: allowedOidcUserId }),
	logger,
	requireHttps: !loopbackOnly,
	trustTlsProxy: behindTlsProxy,
	fleetHostnames,
	preferredNewEventSchemaVersion,
})

const server = Bun.serve({
	hostname,
	port,
	fetch: app.fetch,
	...(directTls
		? { tls: { cert: Bun.file(certificatePath!), key: Bun.file(keyPath!) } }
		: {}),
})

logger.info('service_started', { port: server.port, tls: directTls ? 'direct' : behindTlsProxy ? 'proxy' : 'loopback' })

function shutdown(): void {
	server.stop()
	store.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function parsePort(value: string | undefined): number {
	const port = value ? Number(value) : 3000
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be 1-65535')
	return port
}
