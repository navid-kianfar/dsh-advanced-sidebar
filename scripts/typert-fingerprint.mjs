/**
 * The one definition of what the Typert artifact under `generated/` is derived FROM.
 *
 * `generated/` is a build output this package cannot rebuild from a compiler: the harness's Typert
 * generator only runs inside a deepseek-harness checkout. It is therefore authored to that
 * generator's format by `scripts/emit-typert.mjs` and committed — and a committed build output rots
 * silently unless something watches its inputs. The fingerprint is that watch: any edit to the wire
 * contract or to the `@Remote` surface invalidates it.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Sources the artifact is derived from: the `@Remote` methods and the types they name. */
export const TYPERT_INPUTS = ['src/host/index.ts', 'src/host/types.ts', 'scripts/emit-typert.mjs']

/** Where the recorded fingerprint lives. */
export const FINGERPRINT_FILE = 'generated/.fingerprint'

/** Package root, resolved from this script's own location. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Hash the artifact's inputs.
 * @returns a hex digest covering every input file, in a fixed order.
 */
export async function fingerprint() {
  const hash = createHash('sha256')
  for (const relative of TYPERT_INPUTS) {
    hash.update(relative)
    hash.update(await readFile(new URL(relative, `file://${ROOT}`)))
  }
  return hash.digest('hex')
}

/**
 * Read the `@Remote` method names the Host currently declares.
 * @returns the declared endpoint names, in source order.
 */
export async function declaredEndpoints() {
  const source = await readFile(new URL('src/host/index.ts', `file://${ROOT}`), 'utf8')
  return [...source.matchAll(/@Remote\('([^']+)'\)/g)].map(match => match[1])
}

/**
 * Read the endpoint names the committed artifact carries.
 * @returns the generated method names, in artifact order.
 */
export async function generatedEndpoints() {
  const source = await readFile(new URL('generated/typert.remote-client.js', `file://${ROOT}`), 'utf8')
  return [...source.matchAll(/^\s+method: '([^']+)',$/gm)].map(match => match[1])
}
