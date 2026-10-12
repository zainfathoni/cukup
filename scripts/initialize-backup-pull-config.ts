import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultBackupPullConfigPath, loadBackupPullConfig } from '../service/backup-pull.ts'

function initializeConfig(configPath: string, sshBinary: string, rsyncBinary: string): void {
	if (existsSync(configPath)) {
		loadBackupPullConfig(configPath)
		console.log(`Kept existing private backup pull config: ${configPath}`)
		return
	}
	const directory = dirname(configPath)
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	chmodSync(directory, 0o700)
	const config = {
		remoteHost: 'production-host',
		remoteDirectory: '/srv/example-cukup-backups',
		localDirectory: join(homedir(), '.local', 'state', 'cukup-backups', 'pairs'),
		sshBinary,
		rsyncBinary,
	}
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
		flag: 'wx',
		mode: 0o600,
	})
	console.log(`Created private backup pull config without a monitoring URL: ${configPath}`)
}

if (import.meta.main) {
	const args = process.argv.slice(2)
	const [configPath, sshBinary, rsyncBinary] = args
	if (args.length !== 3 || !configPath || !sshBinary || !rsyncBinary) {
		console.error('Usage: initialize-backup-pull-config <config-path> <ssh-path> <rsync-path>')
		process.exitCode = 2
	} else {
		try {
			initializeConfig(configPath || defaultBackupPullConfigPath(), sshBinary, rsyncBinary)
		} catch (error) {
			console.error(error instanceof Error ? error.message : 'Could not initialize backup pull config')
			process.exitCode = 1
		}
	}
}
