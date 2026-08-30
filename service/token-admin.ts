import { defaultServiceDatabasePath } from './config.ts'
import { ServiceStore } from './store.ts'

function usage(): never {
	console.error(`Usage:
  bun run service:token issue [database]
  bun run service:token rotate <token-id> [database]
  bun run service:token revoke <token-id> [database]
  bun run service:token list [database]`)
	process.exit(2)
}

export function runTokenAdmin(args: string[]): void {
	const [command, identifier, optionalDatabase] = args
	const needsIdentifier = command === 'rotate' || command === 'revoke'
	const database = needsIdentifier ? optionalDatabase : identifier
	const store = new ServiceStore(database ?? defaultServiceDatabasePath())
	try {
		if (command === 'issue' && args.length <= 2) {
			const issued = store.issueBearer()
			console.log(JSON.stringify({ token_id: issued.tokenId, token: issued.token }))
			return
		}
		if (command === 'rotate' && identifier && args.length <= 3) {
			const issued = store.rotateBearer(identifier)
			console.log(JSON.stringify({ token_id: issued.tokenId, token: issued.token }))
			return
		}
		if (command === 'revoke' && identifier && args.length <= 3) {
			if (!store.revokeBearer(identifier)) throw new Error('Active bearer credential not found')
			console.log(JSON.stringify({ revoked: true }))
			return
		}
		if (command === 'list' && args.length <= 2) {
			console.log(JSON.stringify(store.listBearerMetadata()))
			return
		}
		usage()
	} finally {
		store.close()
	}
}

if (import.meta.main) runTokenAdmin(process.argv.slice(2))
