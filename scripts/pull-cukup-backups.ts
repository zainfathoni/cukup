import {
	defaultBackupPullConfigPath,
	loadBackupPullConfig,
	runBackupPull,
} from '../service/backup-pull.ts'

function configPathFromArguments(args: string[]): string {
	if (args.length === 0) return defaultBackupPullConfigPath()
	if (args.length === 2 && args[0] === '--config') return args[1]!
	throw new Error('Usage: pull-cukup-backups [--config <path>]')
}

if (import.meta.main) {
	try {
		const config = loadBackupPullConfig(configPathFromArguments(process.argv.slice(2)))
		const report = await runBackupPull(config)
		console.log(JSON.stringify(report))
		if (report.backup.status !== 'success' || report.monitoring.status === 'failure') {
			process.exitCode = 1
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown backup pull failure'
		console.error(JSON.stringify({ backup: { status: 'failure' }, error: message }))
		process.exitCode = 1
	}
}
