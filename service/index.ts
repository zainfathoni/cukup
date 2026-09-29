import { createApp } from './app.ts'
import { OidcVerifier } from './auth.ts'
import {
	configuredAllowedOidcUserId,
	configuredApiHostname,
	configuredDashboard,
	configuredDashboardHostname,
	configuredFleetHostnames,
	configuredNewTurnEventSchemaVersion,
	defaultServiceDatabasePath,
} from './config.ts'
import { DashboardBackend, type DashboardAssets } from './dashboard/backend.ts'
import { loadExplainerAssets } from './dashboard/explainer.ts'
import { loadSocialImage } from './dashboard/social-image.ts'
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
const apiHostname = configuredApiHostname()
const dashboardHostname = configuredDashboardHostname()
const dashboardConfiguration = configuredDashboard(process.env, dashboardHostname)
const fleetHostnames = configuredFleetHostnames()
const preferredNewEventSchemaVersion = configuredNewTurnEventSchemaVersion()
const store = new ServiceStore(defaultServiceDatabasePath())
const logger = new ServiceLogger()
let dashboard: DashboardBackend | undefined
if (dashboardConfiguration) {
	try {
		const explainer =
			(await loadExplainerAssets(`${import.meta.dir}/explainer`)) ??
			(await loadExplainerAssets(`${import.meta.dir}/../media/motion-explainer`))
		if (!explainer) logger.error('explainer_unavailable', { error: 'assets_missing' })
		const socialImage =
			(await loadSocialImage(import.meta.dir)) ?? (await loadSocialImage(`${import.meta.dir}/../media/og-image`))
		if (!socialImage) logger.error('social_image_unavailable', { error: 'asset_missing' })
		dashboard = new DashboardBackend({
			config: dashboardConfiguration,
			store,
			assets: await loadDashboardAssets(),
			explainer,
			socialImage,
		})
	} catch {
		logger.error('dashboard_disabled', { error: 'initialization_failed' })
	}
}
const app = createApp({
	store,
	oidcVerifier: new OidcVerifier({ allowedUserId: allowedOidcUserId }),
	logger,
	requireHttps: !loopbackOnly,
	trustTlsProxy: behindTlsProxy,
	fleetHostnames,
	preferredNewEventSchemaVersion,
	apiHostname,
	dashboardHostname,
	dashboard,
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

async function loadDashboardAssets(): Promise<DashboardAssets> {
	const builtJavascript = Bun.file(`${import.meta.dir}/dashboard.js`)
	const builtCss = Bun.file(`${import.meta.dir}/dashboard.css`)
	if ((await builtJavascript.exists()) && (await builtCss.exists())) {
		return { javascript: await builtJavascript.text(), css: await builtCss.text() }
	}
	const sourceClient = `${import.meta.dir}/dashboard/client.ts`
	const sourceCss = Bun.file(`${import.meta.dir}/dashboard/dashboard.css`)
	const build = await Bun.build({
		entrypoints: [sourceClient],
		target: 'browser',
		minify: true,
	})
	if (!build.success || build.outputs.length !== 1 || !(await sourceCss.exists())) {
		throw new Error('Dashboard assets are unavailable')
	}
	return { javascript: await build.outputs[0]!.text(), css: await sourceCss.text() }
}
