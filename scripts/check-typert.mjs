/**
 * Fail when the committed Typert artifact no longer matches the Host surface it was derived from.
 *
 * A stale artifact is not a build error — it is a silent wire mismatch: the browser validates
 * arguments and results against schemas that no longer describe what the Host sends. This check is
 * the only thing standing between an edit to `src/host/` and that failure reaching a user.
 */
import { readFile } from 'node:fs/promises'
import {
  FINGERPRINT_FILE, ROOT, declaredEndpoints, fingerprint, generatedEndpoints,
} from './typert-fingerprint.mjs'

const REGENERATE = 'update scripts/emit-typert.mjs, run `pnpm run regen:typert`, and commit generated/'

// Compared as SETS, not as sequences: the artifact lists endpoints alphabetically while
// `src/host/index.ts` declares them in whatever order reads best, so an ordered comparison would
// report a mismatch that says nothing about whether the artifact is current.
const declared = await declaredEndpoints()
const generated = await generatedEndpoints()
const missing = declared.filter(name => !generated.includes(name))
const extra = generated.filter(name => !declared.includes(name))
if (missing.length > 0 || extra.length > 0) {
  console.error('typert: endpoints differ.')
  if (missing.length > 0) console.error(`  declared in src/host but absent from generated/: ${missing.join(', ')}`)
  if (extra.length > 0) console.error(`  carried by generated/ but no longer declared: ${extra.join(', ')}`)
  console.error(`  ${REGENERATE}`)
  process.exit(1)
}

let recorded
try {
  recorded = (await readFile(new URL(FINGERPRINT_FILE, `file://${ROOT}`), 'utf8')).trim()
} catch {
  // No fingerprint at all means the artifact predates this check, which is indistinguishable from
  // stale — refuse rather than assume it happens to be current.
  console.error(`typert: ${FINGERPRINT_FILE} is missing; ${REGENERATE}`)
  process.exit(1)
}

const current = await fingerprint()
if (recorded !== current) {
  console.error(`typert: the Host wire contract changed since generated/ was produced.\n  ${REGENERATE}`)
  console.error('  (a comment-only edit to src/host/types.ts trips this too — re-emitting is cheap and always correct)')
  process.exit(1)
}
console.log(`typert: artifact matches the Host surface (${declared.length} endpoint(s))`)
