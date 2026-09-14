import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import {
  FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE, PreviewSurface,
} from '../src/host/preview-serve.ts'
import type { AdvancedSidebarSettings } from '../src/host/types.ts'

/**
 * The same-origin routes, driven end to end with a faked `ctx`.
 *
 * This is the part of the feature with the most ways to go quietly wrong — a path that escapes the
 * workspace, a proxy that answers a public host, a document served without its charset, a `HEAD`
 * that writes a body. Each is a request through the real handler here rather than an assertion about
 * a helper it calls, because the failure that matters is the one between the helper and the wire.
 *
 * The fakes are deliberately small: a filesystem with exactly the methods these handlers call, and a
 * response that records what was written. Where the harness's own types are stricter than a fake can
 * honestly satisfy, the cast is confined to one line with the reason beside it.
 */

/** One entry in the fake filesystem. */
interface FakeFile {
  readonly bytes: Uint8Array
  readonly version?: string
}

/** A request, as `IncomingMessage` for one verb, path, and header set. */
function request(method: string, url: string, headers: Record<string, string> = {}, body = ''): IncomingMessage {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  // A fake cannot satisfy the whole `IncomingMessage` surface, and nothing here reads more than
  // these four members — the cast says that rather than widening the handler's own types.
  return Object.assign(stream, { method, url, headers }) as unknown as IncomingMessage
}

/** What one response did. */
interface Captured {
  status: number
  headers: Record<string, string>
  body: string
  ended: boolean
}

/** Collect a response into something assertable. */
function response(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '', ended: false }
  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = String(value)
    },
    writeHead(status: number) { captured.status = status; return res },
    end(chunk?: unknown) {
      captured.ended = true
      if (typeof chunk === 'string') captured.body += chunk
      else if (chunk instanceof Uint8Array) captured.body += Buffer.from(chunk).toString('utf8')
      return res
    },
    destroy() { captured.ended = true },
    on() { return res },
    once() { return res },
    get headersSent() { return captured.status !== 0 },
  }
  return { res: res as unknown as ServerResponse, captured }
}

/** The settings a surface is built from. */
const SETTINGS: AdvancedSidebarSettings = {
  previewMaxFileBytes: 1_024,
  previewProxyTimeoutMs: 1_000,
} as AdvancedSidebarSettings

/**
 * Paths the fake filesystem reports as directories.
 *
 * Only the workspace roots the tests use: a real backend reports what is actually there, and the
 * fake only needs to agree about the one fact `resolveWorkspace` checks.
 */
const KNOWN_DIRECTORIES = new Set(['/w', '/w/src'])

/**
 * A faked `ctx` with one workspace and a filesystem holding it.
 * @param files - bytes by absolute path, all inside `/w`.
 * @param webServer - whether a web server is mounted.
 * @returns the context and the recorded route registrations.
 */
function context(files: Readonly<Record<string, FakeFile>>, webServer = true): {
  ctx: Context
  registered: { kind: string; path: string }[]
} {
  const registered: { kind: string; path: string }[] = []
  const targetOf = (path: string): FsTarget => ({ displayPath: path } as unknown as FsTarget)
  const fs = {
    resolve: (path: string) => Promise.resolve(targetOf(path)),
    stat: (target: FsTarget) => {
      const path = (target as unknown as { displayPath: string }).displayPath
      // A directory is a directory: `resolveWorkspace` proves the workspace is one before anything
      // else happens, so a fake that answered `file` for every path would make every request fail as
      // "not a directory" and hide the behaviour under test.
      if (KNOWN_DIRECTORIES.has(path)) return Promise.resolve({ type: 'directory', version: 'v1' })
      const file = files[path]
      return Promise.resolve(file === undefined ? undefined : { type: 'file', size: file.bytes.byteLength, version: file.version ?? 'v1' })
    },
    processPath: (target: FsTarget) => (target as unknown as { displayPath: string }).displayPath,
    contains: (parent: FsTarget, child: FsTarget) => {
      const base = (parent as unknown as { displayPath: string }).displayPath
      const path = (child as unknown as { displayPath: string }).displayPath
      return path === base || path.startsWith(`${base}/`)
    },
    readBytes: (target: FsTarget, _signal: unknown, max: number) => {
      const file = files[(target as unknown as { displayPath: string }).displayPath]
      if (file === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve(file.bytes.slice(0, max))
    },
    readByteRange: (target: FsTarget, range: { offset: number; length: number }) => {
      const file = files[(target as unknown as { displayPath: string }).displayPath]
      if (file === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve(file.bytes.slice(range.offset, range.offset + range.length))
    },
  }
  const web = {
    register: (route: { kind: string; path: string }) => {
      registered.push({ kind: route.kind, path: route.path })
      return () => {}
    },
    registerUpgrade: (route: { path: string }) => {
      registered.push({ kind: 'upgrade', path: route.path })
      return () => {}
    },
  }
  const ctx = {
    get: (name: string) => (name === 'fs' ? fs : name === 'webServer' && webServer ? web : undefined),
    inject: (names: readonly string[], body: (scoped: unknown) => void) => {
      if (names.includes('webServer') && webServer) body({ webServer: web })
    },
  }
  return { ctx: ctx as unknown as Context, registered }
}

/** Build a surface over a faked context and register its routes. */
function surfaceOf(files: Readonly<Record<string, FakeFile>>, webServer = true): {
  surface: PreviewSurface
  registered: { kind: string; path: string }[]
} {
  const { ctx, registered } = context(files, webServer)
  const surface = new PreviewSurface(ctx, () => SETTINGS)
  surface.install()
  return { surface, registered }
}

/** A one-line HTML document. */
const HTML = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>'
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Dispatch one request through a private handler, which is the only way to reach it. */
async function file(
  surface: PreviewSurface, method: string, query: string, headers: Record<string, string> = {},
): Promise<Captured> {
  const { res, captured } = response()
  await (surface as unknown as {
    handleFile: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }).handleFile(request(method, `${FILE_ROUTE}?${query}`, headers), res)
  return captured
}

describe('the file route', () => {
  it('registers its routes on the mounted web server, prefix and upgrade included', () => {
    const { registered } = surfaceOf({})
    expect(registered).toEqual([
      { kind: 'exact', path: FILE_ROUTE },
      { kind: 'exact', path: SCRATCHPAD_ROUTE },
      { kind: 'prefix', path: PROXY_ROUTE },
      { kind: 'upgrade', path: PROXY_ROUTE },
    ])
  })

  it('registers nothing at all on a headless Host, and reports why', () => {
    const { surface, registered } = surfaceOf({}, false)
    expect(registered).toEqual([])
    expect(surface.info().available).toBe(false)
    expect(surface.info().reason).toContain('no web server capability')
    // A file framed through the proxy query is impossible without a route, so no URL is offered.
    expect(surface.fileUrl('/w', '/w/a.html')).toBeUndefined()
  })

  it('serves a workspace file with its type, a charset and no caching', async () => {
    const { surface } = surfaceOf({ '/w/a.html': { bytes: bytesOf(HTML) } })
    const captured = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.html')
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.headers['x-content-type-options']).toBe('nosniff')
    expect(captured.headers['etag']).toMatch(/^W\//u)
    // The base is spliced into the head, and it carries the file's own directory as its query.
    expect(captured.body).toContain('<base href="/advanced-sidebar/preview-file?workspace=%2Fw&amp;path=">')
  })

  it('refuses a path outside the workspace', async () => {
    const { surface } = surfaceOf({ '/etc/passwd': { bytes: bytesOf('root:x:0:0') } })
    const captured = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fetc%2Fpasswd')
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('outside')
    expect(captured.body).not.toContain('root:x:0:0')
  })

  it('refuses a path with no workspace to be inside', async () => {
    const { surface } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hi') } })
    const captured = await file(surface, 'GET', 'path=%2Fw%2Fa.txt')
    // With no workspace named, the path IS the workspace, and a file is not a directory.
    expect(captured.status).toBe(404)
  })

  it('answers 304 for a matching validator, and never writes a body for it', async () => {
    const { surface } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hello') } })
    const first = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    const again = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt', {
      'if-none-match': first.headers.etag ?? '',
    })
    expect(again.status).toBe(304)
    expect(again.body).toBe('')
  })

  it('serves a byte range as 206 with a content-range, and the whole file without one', async () => {
    const { surface } = surfaceOf({ '/w/a.bin': { bytes: bytesOf('0123456789') } })
    const ranged = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.bin', { range: 'bytes=2-4' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 2-4/10')
    expect(ranged.body).toBe('234')
    expect(ranged.headers['accept-ranges']).toBe('bytes')
  })

  it('refuses a range past the end with 416', async () => {
    const { surface } = surfaceOf({ '/w/a.bin': { bytes: bytesOf('0123456789') } })
    const captured = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.bin', { range: 'bytes=99-' })
    expect(captured.status).toBe(416)
    expect(captured.headers['content-range']).toBe('bytes */10')
  })

  it('refuses a file over the configured cap without reading it', async () => {
    const { surface } = surfaceOf({ '/w/big.bin': { bytes: new Uint8Array(4_096) } })
    const captured = await file(surface, 'GET', 'workspace=%2Fw&path=%2Fw%2Fbig.bin')
    expect(captured.status).toBe(413)
    expect(captured.body).toContain('previewMaxFileBytes')
  })

  it('accepts only GET and HEAD', async () => {
    const { surface } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('x') } })
    const captured = await file(surface, 'POST', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    expect(captured.status).toBe(405)
  })

  it('writes no body for HEAD but still states a length', async () => {
    const { surface } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hello') } })
    const captured = await file(surface, 'HEAD', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('')
    expect(captured.headers['content-length']).toBe('5')
  })
})

describe('the scratchpad route', () => {
  it('renders a posted document on this origin, with no cache', async () => {
    const { surface } = surfaceOf({})
    const { res, captured } = response()
    await (surface as unknown as {
      handleScratchpad: (req: IncomingMessage, res: ServerResponse) => void
    }).handleScratchpad(request('POST', SCRATCHPAD_ROUTE, {}, '<p>draft</p>'), res)
    // The handler reads the body on an event, so settle the microtask queue before asserting.
    await new Promise(resolve => { setImmediate(resolve) })
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.body).toContain('<p>draft</p>')
    expect(captured.body).toContain('<base href="/">')
  })

  it('answers 204 for a bare GET, so a probe writes nothing', () => {
    const { surface } = surfaceOf({})
    const { res, captured } = response()
    ;(surface as unknown as {
      handleScratchpad: (req: IncomingMessage, res: ServerResponse) => void
    }).handleScratchpad(request('GET', SCRATCHPAD_ROUTE), res)
    expect(captured.status).toBe(204)
    expect(captured.body).toBe('')
  })
})

describe('the preview proxy', () => {
  it('refuses a request whose Origin is not this GUI', async () => {
    const { surface } = surfaceOf({})
    const { res, captured } = response()
    await (surface as unknown as {
      handleProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }).handleProxy(
      request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://127.0.0.1:5173/')}`, {
        origin: 'https://evil.example', host: '127.0.0.1:3080',
      }),
      res,
    )
    expect(captured.status).toBe(403)
    expect(captured.body).toContain('this GUI')
  })

  it('refuses a non-loopback target before any connection is attempted', async () => {
    const { surface } = surfaceOf({})
    const { res, captured } = response()
    await (surface as unknown as {
      handleProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }).handleProxy(
      request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`, {
        host: '127.0.0.1:3080',
      }),
      res,
    )
    expect(captured.status).toBe(403)
    expect(captured.body).toContain('169.254.169.254')
  })

  it('refuses a subresource with no target it can place', async () => {
    const { surface } = surfaceOf({})
    const { res, captured } = response()
    await (surface as unknown as {
      handleProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }).handleProxy(request('GET', `${PROXY_ROUTE}/app.js`, { host: '127.0.0.1:3080' }), res)
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('loopback target')
  })

  it('refuses everything once the surface is disposed', async () => {
    const { surface } = surfaceOf({})
    surface.dispose()
    const { res, captured } = response()
    await (surface as unknown as {
      handleProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }).handleProxy(
      request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://127.0.0.1:5173/')}`, { host: 'h' }),
      res,
    )
    expect(captured.status).toBe(503)
  })

  it('forgets a panel target when it is released', () => {
    const { surface } = surfaceOf({})
    surface.rememberTarget('c-1', 'http://127.0.0.1:5173/')
    surface.rememberTarget('c-1', undefined)
    // With nothing remembered, a suffix request cannot be placed — which is the state a closed panel
    // should leave behind, rather than a stale target that serves another tab's subresources.
    const { res, captured } = response()
    void (surface as unknown as {
      handleProxy: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }).handleProxy(request('GET', `${PROXY_ROUTE}/app.js`, { 'x-dsh-preview-client': 'c-1' }), res)
    expect(captured.status).toBe(404)
  })
})

describe('file description', () => {
  it('classifies by extension and offers a same-origin URL for everything except unknown types', async () => {
    const { surface } = surfaceOf({
      '/w/index.html': { bytes: bytesOf(HTML) },
      '/w/readme.md': { bytes: bytesOf('# hi') },
      '/w/shot.png': { bytes: bytesOf('png') },
      '/w/blob': { bytes: bytesOf('not text') },
      '/w/src/app.ts': { bytes: bytesOf('const a = 1') },
    })
    const html = await surface.info_('/w', '/w/index.html')
    expect(html.ok && html.kind).toBe('iframe')
    expect(html.ok && html.url).toContain(FILE_ROUTE)
    const md = await surface.info_('/w', '/w/readme.md')
    expect(md.ok && md.kind).toBe('markdown')
    expect(md.ok && md.url).toContain(FILE_ROUTE)
    const png = await surface.info_('/w', '/w/shot.png')
    expect(png.ok && png.kind).toBe('image')
    const text = await surface.info_('/w', '/w/src/app.ts')
    expect(text.ok && text.kind).toBe('text')
    // An unknown type has nothing to point a browser at, so no URL is claimed for it.
    const blob = await surface.info_('/w', '/w/blob')
    expect(blob.ok && blob.kind).toBe('other')
    expect(blob.ok && blob.url).toBeUndefined()
  })

  it('reports a size over the cap rather than refusing the file', async () => {
    const { surface } = surfaceOf({ '/w/big.bin': { bytes: new Uint8Array(4_096) } })
    const info = await surface.info_('/w', '/w/big.bin')
    expect(info.ok).toBe(true)
    expect(info.ok && info.withinLimit).toBe(false)
    expect(info.ok && info.bytes).toBe(4_096)
  })

  it('refuses a directory, and a path outside the workspace', async () => {
    const { surface } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('x') } })
    const missing = await surface.info_('/w', '/w/nope.txt')
    expect(missing.ok).toBe(false)
    const outside = await surface.info_('/w', '/etc/passwd')
    expect(outside.ok).toBe(false)
    expect(outside.ok ? '' : outside.code).toBe('path-denied')
  })

  it('moves the token when the bytes do, and not when they do not', async () => {
    const files: Record<string, FakeFile> = { '/w/a.txt': { bytes: bytesOf('one') } }
    const { surface } = surfaceOf(files)
    const first = await surface.info_('/w', '/w/a.txt')
    const same = await surface.info_('/w', '/w/a.txt')
    expect(first.ok && same.ok && first.token === same.token).toBe(true)
    // A backend whose version token does not move still gets a different reading from the head hash.
    files['/w/a.txt'] = { bytes: bytesOf('two') }
    const changed = await surface.info_('/w', '/w/a.txt')
    expect(changed.ok && first.ok && changed.token !== first.token).toBe(true)
  })
})
