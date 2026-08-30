import { defaultServiceDatabasePath } from './config.ts'
import { backupDatabase, inspectDatabase, restoreDatabase, verifyBackup } from './operations.ts'

function usage(): never {
	console.error(`Usage:
  bun run service:db integrity [database]
  bun run service:db backup <destination-directory> [database]
  bun run service:db verify <backup.sqlite> [metadata.json]
  bun run service:db restore <backup.sqlite> <target.sqlite> [metadata.json] [--replace]`)
	process.exit(2)
}

export function runDatabaseOperations(args: string[]): void {
	const [command, ...rest] = args
	if (command === 'integrity' && rest.length <= 1) {
		const path = rest[0] ?? defaultServiceDatabasePath()
		console.log(JSON.stringify(inspectDatabase(path)))
		return
	}
	if (command === 'backup' && rest.length >= 1 && rest.length <= 2) {
		const result = backupDatabase(rest[1] ?? defaultServiceDatabasePath(), rest[0]!)
		console.log(JSON.stringify(result.metadata))
		return
	}
	if (command === 'verify' && rest.length >= 1 && rest.length <= 2) {
		console.log(JSON.stringify(verifyBackup(rest[0]!, rest[1])))
		return
	}
	if (command === 'restore') {
		const replace = rest.includes('--replace')
		const positional = rest.filter((value) => value !== '--replace')
		if (positional.length < 2 || positional.length > 3) usage()
		restoreDatabase(positional[0]!, positional[1]!, {
			metadataPath: positional[2],
			replace,
		})
		console.log(JSON.stringify({ restored: true }))
		return
	}
	usage()
}

if (import.meta.main) runDatabaseOperations(process.argv.slice(2))
