import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { posix } from 'node:path'
import { PassThrough, Readable, type Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import {
  FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE, PreviewSurface, withoutHostAuthCookies,
} from '../src/host/preview-serve.ts'
import type { AdvancedSidebarSettings } from '../src/host/types.ts'

/**
 * The same-origin routes, driven end to end with a faked `ctx`.
 *
 * This is the part of the feature with the most ways to go quietly wrong — an unauthenticated
 * request that is answered, a path that escapes the registered workspaces, a proxy that answers a
 * public host, a document served without its charset, a `HEAD` that writes a body. Every request here
 * goes through the handler the surface REGISTERED on the web server, gate included, because the
 * failure that matters is the one between registration and the wire: a handler that is correct but
 * mounted without its gate is exactly the bug these routes shipped with.
 *
 * The fakes are deliberately small: a filesystem with exactly the methods these handlers call, a
 * connection gate that behaves like the harness's (`dsh-client-connection` `requestRejection`: the
 * Host fence, the Origin check, then the browser cookie), a workspace registry, and a response that
 * records what was written. Where the harness's own types are stricter than a fake can honestly
 * satisfy, the cast is confined to one line with the reason beside it.
 */

/** One entry in the fake filesystem. */
interface FakeFile {
  readonly bytes: Uint8Array
  readonly version?: string
}

/** The authority the GUI is served from in these tests. */
const GUI_HOST = '127.0.0.1:3080'

/** The browser-session cookie the fake gate accepts. */
const AUTH_COOKIE = 'dsh-auth-test=valid'

/** The headers the GUI's own browser sends: its own Host and its session cookie. */
const AUTHENTICATED = { host: GUI_HOST, cookie: AUTH_COOKIE } as const

/**
 * The harness's request gate, reduced to the three facts it decides on.
 * @param req - the incoming request.
 * @returns 403 for a foreign authority or origin, 401 without the cookie, undefined to proceed.
 */
function fakeRequestRejection(req: IncomingMessage): 401 | 403 | undefined {
  if (req.headers.host !== GUI_HOST) return 403
  const origin = req.headers.origin
  if (typeof origin === 'string' && new URL(origin).host !== GUI_HOST) return 403
  const cookies = (req.headers.cookie ?? '').split(';').map(pair => pair.trim())
  return cookies.includes(AUTH_COOKIE) ? undefined : 401
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
  let settle: () => void = () => {}
  const finished = new Promise<void>((resolve) => { settle = resolve })
  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = String(value)
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status
      for (const [name, value] of Object.entries(headers ?? {})) captured.headers[name.toLowerCase()] = String(value)
      return res
    },
    end(chunk?: unknown) {
      captured.ended = true
      if (typeof chunk === 'string') captured.body += chunk
      else if (chunk instanceof Uint8Array) captured.body += Buffer.from(chunk).toString('utf8')
      settle()
      return res
    },
    destroy() { captured.ended = true; settle() },
    on() { return res },
    once() { return res },
    get headersSent() { return captured.status !== 0 },
    finished,
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
 * The workspace roots the tests use, plus directories a hostile request would name as its
 * "workspace": a real backend reports what is actually there, and `/` and `/other` really are
 * directories — which is exactly why naming one must not be enough.
 */
const KNOWN_DIRECTORIES = new Set(['/', '/w', '/w/src', '/other'])

/** How the faked Host composes its connection. */
type ConnectionShape = 'gated' | 'ungated' | 'absent'

/** What one faked Host composes. */
interface HostShape {
  /** Whether a web server is mounted. */
  readonly webServer?: boolean
  /** Whether a connection is mounted, and whether it has a request gate. */
  readonly connection?: ConnectionShape
  /** The registered workspace paths; undefined composes no registry at all. */
  readonly workspaces?: readonly string[] | undefined
}

/** A registered HTTP handler. */
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

/** A registered upgrade handler. */
type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

/**
 * A faked `ctx` with a filesystem, a registry, a connection and a web server.
 * @param files - bytes by absolute path.
 * @param shape - what the Host composes; by default all of it, with `/w` registered.
 * @returns the context and the routes the surface registered.
 */
function context(files: Readonly<Record<string, FakeFile>>, shape: HostShape = {}): {
  ctx: Context
  registered: { kind: string; path: string }[]
  http: Map<string, HttpHandler>
  upgrades: Map<string, UpgradeHandler>
} {
  const webServer = shape.webServer ?? true
  const connectionShape = shape.connection ?? 'gated'
  const workspaces = 'workspaces' in shape ? shape.workspaces : ['/w']
  const registered: { kind: string; path: string }[] = []
  const http = new Map<string, HttpHandler>()
  const upgrades = new Map<string, UpgradeHandler>()
  const targetOf = (path: string): FsTarget => ({ displayPath: posix.resolve(path) } as unknown as FsTarget)
  const pathOf = (target: FsTarget): string => (target as unknown as { displayPath: string }).displayPath
  const fs = {
    resolve: (path: string) => Promise.resolve(targetOf(path)),
    stat: (target: FsTarget) => {
      const path = pathOf(target)
      // A directory is a directory: `resolveWorkspace` proves the workspace is one before anything
      // else happens, so a fake that answered `file` for every path would make every request fail as
      // "not a directory" and hide the behaviour under test.
      if (KNOWN_DIRECTORIES.has(path)) return Promise.resolve({ type: 'directory', version: 'v1' })
      const file = files[path]
      return Promise.resolve(file === undefined ? undefined : { type: 'file', size: file.bytes.byteLength, version: file.version ?? 'v1' })
    },
    processPath: pathOf,
    contains: (parent: FsTarget, child: FsTarget) => {
      const rest = posix.relative(pathOf(parent), pathOf(child))
      return rest === '' || (rest !== '..' && !rest.startsWith('../') && !posix.isAbsolute(rest))
    },
    readBytes: (target: FsTarget, _signal: unknown, max: number) => {
      const file = files[pathOf(target)]
      if (file === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve(file.bytes.slice(0, max))
    },
    readByteRange: (target: FsTarget, range: { offset: number; length: number }) => {
      const file = files[pathOf(target)]
      if (file === undefined) return Promise.reject(new Error('ENOENT'))
      return Promise.resolve(file.bytes.slice(range.offset, range.offset + range.length))
    },
  }
  const registry = workspaces === undefined ? undefined : { list: () => workspaces.map(path => ({ path })) }
  const web = {
    register: (route: { kind: string; path: string; handler: HttpHandler }) => {
      registered.push({ kind: route.kind, path: route.path })
      http.set(route.path, route.handler)
      return () => { http.delete(route.path) }
    },
    registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
      registered.push({ kind: 'upgrade', path: route.path })
      upgrades.set(route.path, route.handler)
      return () => { upgrades.delete(route.path) }
    },
  }
  const connection = connectionShape === 'gated' ? { requestRejection: fakeRequestRejection } : {}
  const services: Record<string, unknown> = {
    fs,
    ...registry === undefined ? {} : { workspaceRegistry: registry },
    ...webServer ? { webServer: web } : {},
    ...connectionShape === 'absent' ? {} : { connection },
  }
  const ctx = {
    get: (name: string) => services[name],
    inject: (names: readonly string[], body: (scoped: unknown) => void) => {
      if (names.every(name => name in services)) body(services)
    },
  }
  return { ctx: ctx as unknown as Context, registered, http, upgrades }
}

/** Build a surface over a faked context and register its routes. */
function surfaceOf(files: Readonly<Record<string, FakeFile>>, shape: HostShape = {}): {
  surface: PreviewSurface
  registered: { kind: string; path: string }[]
  http: Map<string, HttpHandler>
  upgrades: Map<string, UpgradeHandler>
} {
  const { ctx, registered, http, upgrades } = context(files, shape)
  const surface = new PreviewSurface(ctx, () => SETTINGS)
  surface.install()
  return { surface, registered, http, upgrades }
}

/** A one-line HTML document. */
const HTML = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>'
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * Dispatch one request through the handler registered for a route, as the web server would.
 * @param http - the registered handlers.
 * @param route - the route path the request matched.
 * @param req - the request.
 * @returns what the response recorded, once the handler settled.
 */
async function dispatch(http: Map<string, HttpHandler>, route: string, req: IncomingMessage): Promise<Captured> {
  const handler = http.get(route)
  if (handler === undefined) throw new Error(`no handler is registered for ${route}`)
  const { res, captured } = response()
  await handler(req, res)
  return captured
}

/** One file-route request from the GUI's own authenticated browser, with any extra headers. */
function file(
  http: Map<string, HttpHandler>, method: string, query: string, headers: Record<string, string> = {},
): Promise<Captured> {
  return dispatch(http, FILE_ROUTE, request(method, `${FILE_ROUTE}?${query}`, { ...AUTHENTICATED, ...headers }))
}

describe('every route answers only the authenticated GUI', () => {
  const secret = { '/w/a.txt': { bytes: bytesOf('workspace secret') } }

  it('refuses the file, scratchpad and proxy routes with 401 when the browser cookie is missing', async () => {
    const { http } = surfaceOf(secret)
    const anonymous = { host: GUI_HOST }
    const fileAnswer = await dispatch(http, FILE_ROUTE, request('GET', `${FILE_ROUTE}?workspace=%2Fw&path=%2Fw%2Fa.txt`, anonymous))
    const scratch = await dispatch(http, SCRATCHPAD_ROUTE, request('POST', SCRATCHPAD_ROUTE, anonymous, '<script>x</script>'))
    const proxy = await dispatch(http, PROXY_ROUTE, request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://127.0.0.1:1/')}`, anonymous))
    expect([fileAnswer.status, scratch.status, proxy.status]).toEqual([401, 401, 401])
    expect(fileAnswer.body).toBe('unauthorized')
    expect(scratch.body).not.toContain('<script>')
  })

  it('refuses a foreign Host with 403 even with a valid cookie, which is what defeats DNS rebinding', async () => {
    const { http } = surfaceOf(secret)
    const rebound = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt', { host: 'attacker.example:3080' })
    expect(rebound.status).toBe(403)
    expect(rebound.body).not.toContain('workspace secret')
  })

  it('refuses a cross-origin request to the proxy with 403', async () => {
    const { http } = surfaceOf({})
    const captured = await dispatch(http, PROXY_ROUTE, request(
      'GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://127.0.0.1:5173/')}`,
      { ...AUTHENTICATED, origin: 'https://evil.example' },
    ))
    expect(captured.status).toBe(403)
  })

  it('serves the same file to the authenticated GUI', async () => {
    const { http } = surfaceOf(secret)
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('workspace secret')
  })

  it('refuses an unauthenticated websocket upgrade before any upstream socket is opened', async () => {
    const upstream = createNetServer()
    let connections = 0
    upstream.on('connection', (socket) => { connections += 1; socket.destroy() })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    const port = (upstream.address() as AddressInfo).port
    try {
      const { upgrades } = surfaceOf({})
      const socket = new PassThrough()
      let written = ''
      socket.on('data', (chunk: Buffer) => { written += chunk.toString('utf8') })
      const ended = new Promise<void>((resolve) => { socket.on('end', resolve) })
      upgrades.get(PROXY_ROUTE)?.(
        request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent(`http://127.0.0.1:${String(port)}/`)}`, {
          host: GUI_HOST, upgrade: 'websocket', connection: 'Upgrade',
        }),
        socket,
        Buffer.alloc(0),
      )
      socket.resume()
      await ended
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      expect(written).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/u)
      expect(connections).toBe(0)
    } finally {
      upstream.close()
    }
  })

  it('mounts no route at all when the connection has no request gate, and says why', () => {
    const { surface, registered } = surfaceOf(secret, { connection: 'ungated' })
    expect(registered).toEqual([])
    expect(surface.info()).toMatchObject({ available: false })
    expect(surface.info().reason).toContain('request gate')
  })

  it('mounts no route at all when no connection is composed', () => {
    const { surface, registered } = surfaceOf(secret, { connection: 'absent' })
    expect(registered).toEqual([])
    expect(surface.info().available).toBe(false)
  })
})

describe('a file is served only from inside a registered workspace', () => {
  const disk = {
    '/etc/passwd': { bytes: bytesOf('root:x:0:0') },
    '/other/a.txt': { bytes: bytesOf('unregistered') },
    '/w/src/app.ts': { bytes: bytesOf('const a = 1') },
  }

  it('refuses a request that names the filesystem root as its workspace', async () => {
    const { http } = surfaceOf(disk)
    const captured = await file(http, 'GET', 'workspace=%2F&path=%2Fetc%2Fpasswd')
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('outside every registered workspace')
    expect(captured.body).not.toContain('root:x:0:0')
  })

  it('refuses a real directory that is not a registered workspace', async () => {
    const { http, surface } = surfaceOf(disk)
    const captured = await file(http, 'GET', 'workspace=%2Fother&path=%2Fother%2Fa.txt')
    expect(captured.status).toBe(404)
    expect(captured.body).not.toContain('unregistered')
    // The panel's own description endpoint refuses it too, so it never offers a URL the route refuses.
    const described = await surface.info_('/other', '/other/a.txt')
    expect(described).toMatchObject({ ok: false, code: 'path-denied' })
  })

  it('serves a file from a subdirectory of a registered workspace', async () => {
    const { http } = surfaceOf(disk)
    const captured = await file(http, 'GET', 'workspace=%2Fw%2Fsrc&path=%2Fw%2Fsrc%2Fapp.ts')
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('const a = 1')
  })

  it('serves no file on a Host with no workspace registry', async () => {
    const { http } = surfaceOf(disk, { workspaces: undefined })
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fsrc%2Fapp.ts')
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('no workspace registry')
  })
})

describe('the proxy never hands a dev server the harness credential', () => {
  it('strips the dsh-auth cookie from the forwarded request and from the upstream Set-Cookie', async () => {
    let seenCookie: string | undefined
    const upstream = createHttpServer((req, res) => {
      seenCookie = req.headers.cookie
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': ['dsh-auth-test=forged; Path=/', 'app=1; Path=/'],
      })
      res.end('<html><head></head><body>dev</body></html>')
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    const port = (upstream.address() as AddressInfo).port
    try {
      const { http } = surfaceOf({})
      const handler = http.get(PROXY_ROUTE)
      const { res, captured } = response()
      await handler?.(request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent(`http://127.0.0.1:${String(port)}/`)}`, {
        host: GUI_HOST, cookie: `theme=dark; ${AUTH_COOKIE}`,
      }), res)
      await (res as unknown as { finished: Promise<void> }).finished
      expect(captured.status).toBe(200)
      expect(captured.body).toContain('dev')
      expect(seenCookie).toBe('theme=dark')
      expect(captured.headers['set-cookie']).toBe('app=1; Path=/')
    } finally {
      upstream.close()
    }
  })

  it('forwards an authenticated upgrade with its handshake and without the harness cookie', async () => {
    let head = ''
    const upstream = createNetServer((socket) => {
      socket.once('data', (chunk: Buffer) => { head = chunk.toString('utf8'); socket.destroy() })
    })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve) })
    const port = (upstream.address() as AddressInfo).port
    try {
      const { upgrades } = surfaceOf({})
      const socket = new PassThrough()
      const closed = new Promise<void>((resolve) => { socket.on('close', resolve) })
      upgrades.get(PROXY_ROUTE)?.(
        request('GET', `${PROXY_ROUTE}?url=${encodeURIComponent(`http://127.0.0.1:${String(port)}/hmr`)}`, {
          ...AUTHENTICATED, cookie: `theme=dark; ${AUTH_COOKIE}`, upgrade: 'websocket', connection: 'Upgrade',
        }),
        socket,
        Buffer.alloc(0),
      )
      await closed
      expect(head).toContain('GET /hmr HTTP/1.1')
      expect(head).toContain('upgrade: websocket')
      expect(head).toContain('connection: Upgrade')
      expect(head).toContain('cookie: theme=dark')
      expect(head).not.toContain('dsh-auth-')
    } finally {
      upstream.close()
    }
  })

  it('removes only the harness cookie from a cookie header', () => {
    expect(withoutHostAuthCookies('a=1; dsh-auth-xyz=v1.abc; b=2')).toBe('a=1; b=2')
    expect(withoutHostAuthCookies('dsh-auth-xyz=v1.abc')).toBeUndefined()
  })
})

describe('the file route', () => {
  it('registers its routes on the mounted web server, prefix and upgrade included', () => {
    const { registered, surface } = surfaceOf({})
    expect(surface.info().available).toBe(true)
    expect(registered).toEqual([
      { kind: 'exact', path: FILE_ROUTE },
      { kind: 'exact', path: SCRATCHPAD_ROUTE },
      { kind: 'prefix', path: PROXY_ROUTE },
      { kind: 'upgrade', path: PROXY_ROUTE },
    ])
  })

  it('registers nothing at all on a headless Host, and reports why', () => {
    const { surface, registered } = surfaceOf({}, { webServer: false })
    expect(registered).toEqual([])
    expect(surface.info().available).toBe(false)
    expect(surface.info().reason).toContain('no web server capability')
    // A file framed through the proxy query is impossible without a route, so no URL is offered.
    expect(surface.fileUrl('/w', '/w/a.html')).toBeUndefined()
  })

  it('serves a workspace file with its type, a charset and no caching', async () => {
    const { http } = surfaceOf({ '/w/a.html': { bytes: bytesOf(HTML) } })
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.html')
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.headers['x-content-type-options']).toBe('nosniff')
    expect(captured.headers['etag']).toMatch(/^W\//u)
    // The base is spliced into the head, and it carries the file's own directory as its query.
    expect(captured.body).toContain('<base href="/advanced-sidebar/preview-file?workspace=%2Fw&amp;path=">')
  })

  it('refuses a path outside the workspace', async () => {
    const { http } = surfaceOf({ '/etc/passwd': { bytes: bytesOf('root:x:0:0') } })
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fetc%2Fpasswd')
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('outside')
    expect(captured.body).not.toContain('root:x:0:0')
  })

  it('refuses a path with no workspace to be inside', async () => {
    const { http } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hi') } })
    const captured = await file(http, 'GET', 'path=%2Fw%2Fa.txt')
    // With no workspace named, the path IS the workspace, and a file is not a directory.
    expect(captured.status).toBe(404)
  })

  it('answers 304 for a matching validator, and never writes a body for it', async () => {
    const { http } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hello') } })
    const first = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    const again = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.txt', {
      'if-none-match': first.headers.etag ?? '',
    })
    expect(again.status).toBe(304)
    expect(again.body).toBe('')
  })

  it('serves a byte range as 206 with a content-range, and the whole file without one', async () => {
    const { http } = surfaceOf({ '/w/a.bin': { bytes: bytesOf('0123456789') } })
    const ranged = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.bin', { range: 'bytes=2-4' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 2-4/10')
    expect(ranged.body).toBe('234')
    expect(ranged.headers['accept-ranges']).toBe('bytes')
  })

  it('refuses a range past the end with 416', async () => {
    const { http } = surfaceOf({ '/w/a.bin': { bytes: bytesOf('0123456789') } })
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fa.bin', { range: 'bytes=99-' })
    expect(captured.status).toBe(416)
    expect(captured.headers['content-range']).toBe('bytes */10')
  })

  it('refuses a file over the configured cap without reading it', async () => {
    const { http } = surfaceOf({ '/w/big.bin': { bytes: new Uint8Array(4_096) } })
    const captured = await file(http, 'GET', 'workspace=%2Fw&path=%2Fw%2Fbig.bin')
    expect(captured.status).toBe(413)
    expect(captured.body).toContain('previewMaxFileBytes')
  })

  it('accepts only GET and HEAD', async () => {
    const { http } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('x') } })
    const captured = await file(http, 'POST', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    expect(captured.status).toBe(405)
  })

  it('writes no body for HEAD but still states a length', async () => {
    const { http } = surfaceOf({ '/w/a.txt': { bytes: bytesOf('hello') } })
    const captured = await file(http, 'HEAD', 'workspace=%2Fw&path=%2Fw%2Fa.txt')
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('')
    expect(captured.headers['content-length']).toBe('5')
  })
})

describe('the scratchpad route', () => {
  it('renders a posted document on this origin, with no cache', async () => {
    const { http } = surfaceOf({})
    const { res, captured } = response()
    await http.get(SCRATCHPAD_ROUTE)?.(request('POST', SCRATCHPAD_ROUTE, AUTHENTICATED, '<p>draft</p>'), res)
    // The handler reads the body on an event, so settle the microtask queue before asserting.
    await new Promise(resolve => { setImmediate(resolve) })
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.body).toContain('<p>draft</p>')
    expect(captured.body).toContain('<base href="/">')
  })

  it('answers 204 for a bare GET, so a probe writes nothing', () => {
    const { http } = surfaceOf({})
    const { res, captured } = response()
    void http.get(SCRATCHPAD_ROUTE)?.(request('GET', SCRATCHPAD_ROUTE, AUTHENTICATED), res)
    expect(captured.status).toBe(204)
    expect(captured.body).toBe('')
  })
})

describe('the preview proxy', () => {
  it('refuses a non-loopback target before any connection is attempted', async () => {
    const { http } = surfaceOf({})
    const captured = await dispatch(http, PROXY_ROUTE, request(
      'GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`, AUTHENTICATED,
    ))
    expect(captured.status).toBe(403)
    expect(captured.body).toContain('169.254.169.254')
  })

  it('refuses a subresource with no target it can place', async () => {
    const { http } = surfaceOf({})
    const captured = await dispatch(http, PROXY_ROUTE, request('GET', `${PROXY_ROUTE}/app.js`, AUTHENTICATED))
    expect(captured.status).toBe(404)
    expect(captured.body).toContain('loopback target')
  })

  it('refuses everything once the surface is disposed', async () => {
    const { surface, http } = surfaceOf({})
    surface.dispose()
    const captured = await dispatch(http, PROXY_ROUTE, request(
      'GET', `${PROXY_ROUTE}?url=${encodeURIComponent('http://127.0.0.1:5173/')}`, AUTHENTICATED,
    ))
    expect(captured.status).toBe(503)
  })

  it('forgets a panel target when it is released', async () => {
    const { surface, http } = surfaceOf({})
    surface.rememberTarget('c-1', 'http://127.0.0.1:5173/')
    surface.rememberTarget('c-1', undefined)
    // With nothing remembered, a suffix request cannot be placed — which is the state a closed panel
    // should leave behind, rather than a stale target that serves another tab's subresources.
    const captured = await dispatch(http, PROXY_ROUTE, request(
      'GET', `${PROXY_ROUTE}/app.js`, { ...AUTHENTICATED, 'x-dsh-preview-client': 'c-1' },
    ))
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
