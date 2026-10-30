import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

// The only alternate identity is the retained October 22 security baseline.
const baseline = process.argv[2] === '--legacy-trust-baseline'
if (process.argv.length > 2 && (!baseline || process.argv.length > 3)) {
	throw new Error('Unsupported runtime check mode.')
}
const expectedRevision = baseline
	? '963452075e9d7e2a47a482f297143af5ed4f76c0'
	: '38afee6c84fcf48c0edb2466aa4b27d287a59c30'
const expectedHash = baseline
	? 'b31e380ada17d202c5779a486376a350377480ef338410f25973512e30f69c37'
	: '10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235'
const hash = createHash('sha256').update(new Uint8Array(await Bun.file(process.execPath).arrayBuffer())).digest('hex')
if (Bun.revision !== expectedRevision || hash !== expectedHash) {
	throw new Error('Runtime identity does not match the fixed pin.')
}

const database = new Database(':memory:')
try {
	if (database.query('SELECT 1 AS ready').values()[0]?.[0] !== 1) {
		throw new Error('Native SQLite check failed.')
	}
} finally {
	database.close()
}

for (const host of ['dv-g3b-emudhra.we-have-a-problem.com', 'dv-g3b-aaa-emudhra.we-have-a-problem.com']) {
	let rejected = false
	try {
		await fetch(`https://${host}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
	} catch (error) {
		rejected = error instanceof Error && 'code' in error && error.code === 'CERT_REVOKED'
	}
	if (!rejected) throw new Error('Revoked-chain rejection check failed.')
}
const control = await fetch('https://example.com', { redirect: 'error', signal: AbortSignal.timeout(15_000) })
if (control.status !== 200) throw new Error('Valid TLS control check failed.')
console.log(JSON.stringify({ revision: Bun.revision, sha256: hash, sqlite: true, revokedChainsRejected: 2, controlStatus: 200 }))
