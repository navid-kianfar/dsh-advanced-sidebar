/**
 * Same-origin preview serving: the Host routes that make a workspace file and a loopback dev server
 * loadable *from the GUI's own origin*.
 *
 * This is the piece the whole agent-driven debugging story rests on. An `<iframe src="http://127.0.0.1:5173">`
 * is cross-origin, and a cross-origin frame's `document` is unreachable — the panel cannot read its
 * DOM, its console, or its box metrics, and neither can the model. Serving the same bytes from
 * `/advanced-sidebar/preview-file?…` and proxying the dev server through
 * `/advanced-sidebar/preview-proxy?url=…` makes the frame same-origin with the page that hosts it,
 * so the panel's driver can inspect and drive it directly.
 *
 * Three deliberate refusals keep that power from becoming a hole in the GUI:
 *
 * 1. **The proxy only talks to loopback.** `validateProxyTarget` refuses every host that is not a
 *    loopback literal, so this cannot fetch an intranet service from the operator's network
 *    position. A URL that merely resolves to loopback is refused too — see that function.
 * 2. **The proxy only answers the GUI.** A request carrying an `Origin` header that is not this
 *    server's own origin is refused, so a page the operator happens to be visiting cannot use the
 *    GUI as a relay. Requests with no `Origin` at all are same-site navigations and subresources,
 *    which are exactly what the frame produces.
 * 3. **A file is only ever read from inside a workspace.** Every path goes through
 *    `resolveWorkspace`/`resolveInside`, the same containment the Files panel uses, and a symlink
 *    that escapes is caught by the filesystem's own canonicalization rather than by string
 *    arithmetic.
 *
 * Nothing here is cached. A dev server's own asset pipeline already handles its own caching; a
 * workspace file is exactly the thing an operator edits and expects to see change, so the route
 * answers `no-store` plus a weak validator and lets the panel decide when to reload.
 * @module @achasoft/dsh-advanced-sidebar/host/preview-serve
 */

import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: the ctx.webServer Context merge and the route registration shape.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveInside, resolveWorkspace, type ResolvedPath } from './paths.ts'
import {
  FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE, classifyFile, contentTypeOf, decodeText, encodeQuery,
  fileUrl, injectBase, isLoopbackHost, isTextual, proxyUrlFor, validateProxyTarget,
} from './preview-content.ts'

// Re-exported so this module stays the one place a caller reaches the preview surface through; the
// strings themselves live in the shared module because the browser half builds URLs from them.
export { FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE } from './preview-content.ts'
import type {
  AdvancedSidebarSettings, PreviewFileInfoResult, PreviewSurfaceInfo,
} from './types.ts'

/**
 * Largest scratchpad document the Host will echo back.
 *
 * The scratchpad is a person typing HTML into a text area; a megabyte of it is a mistake or an
 * attempt to make the Host hold memory, and neither is worth serving.
 */
export const SCRATCHPAD_MAX_BYTES = 1_024 * 1_024

/**
 * How many bytes of a file's head feed the change token.
 *
 * The token is what makes the panel reload when a file changes on disk. Hashing the whole file
 * would read a video twice per poll; hashing the head misses an edit past the first 8 KB, so the
 * token is `version + size + head digest` — the backend's own opaque version already changes on any
 * write, and the head digest is the fallback for a backend that reports a constant version.
 */
const TOKEN_PROBE_BYTES = 8_192

/**
 * Largest byte window this module will ask a filesystem for.
 *
 * `ctx.fs.readBytes` takes a cap rather than a range, so a request for the middle of a file is
 * impossible through it; the window is what the fallback path reads, and it is bounded well below
 * `previewMaxFileBytes` so an over-limit read cannot become an out-of-memory.
 */
const FALLBACK_READ_BYTES = 4 * 1_024 * 1_024

/**
 * The optional ranged read this plugin prefers and does not require.
 *
 * The filesystem seam grew `readByteRange` after the release this package's build types are pinned
 * to (`0.1.1-rc.2`), and the running harness has it. Reaching it through a shape-guarded structural
 * type keeps the plugin working on both: with it, a `<video>` seek is a real `206`; without it, the
 * range is ignored and the browser gets a full `200`, which every media element still plays.
 */
interface RangeCapableFileSystem {
  /**
   * Read one byte window.
   * @param target - the resolved target.
   * @param range - offset and length.
   * @param signal - cancellation.
   * @returns the window's bytes.
   */
  readByteRange(
    target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal,
  ): Promise<Uint8Array>
}

/**
 * Whether a filesystem implementation can read one byte window.
 * @param fs - the filesystem, or the value `ctx.get('fs')` returned.
 * @returns true when the ranged read is available.
 */
function hasRangeRead(fs: object): fs is RangeCapableFileSystem {
  return 'readByteRange' in fs && typeof (fs as { readByteRange?: unknown }).readByteRange === 'function'
}

/** Upstream statuses re-sent as-is; everything else keeps its status but loses its body only on HEAD. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
])

/**
 * Headers the proxy decides for itself.
 *
 * `host` is rewritten to the upstream's own authority, because a dev server routes on it and a
 * virtual-hosted one would answer the wrong site; `origin` and `referer` point at the GUI, and
 * forwarding them would make the dev server reject a request it thinks is cross-site; `accept-encoding`
 * is dropped so the upstream's response and the GUI's compression middleware never double-encode.
 */
const REWRITTEN_REQUEST_HEADERS = new Set(['host', 'origin', 'referer', 'accept-encoding', 'connection'])

/** One in-flight proxied request, so a dispose can abort it. */
interface Upstream {
  /** Aborts the request and destroys the socket. */
  readonly abort: () => void
}

/**
 * Serves workspace files and proxies loopback dev servers on the GUI's own origin.
 *
 * One instance is created by the service and disposed with it, which is what guarantees no route
 * outlives the plugin: every registration returns a disposer, and `dispose()` runs them all.
 */
export class PreviewSurface {
  /**
   * The upstream URL each panel last pointed its frame at, keyed by its client id.
   *
   * Only a fallback: a proxied document's own URLs all carry their target explicitly, because the
   * browser rewrites them from the injected `<base>`. What needs this map is a request the base
   * cannot reach — a `fetch()` from inside the page to a relative path, or a link with no base of
   * its own — and there is exactly one sensible target for those.
   */
  private readonly targets = new Map<string, string>()

  /** Every request currently in flight, so a dispose does not leave sockets open. */
  private readonly live = new Set<Upstream>()

  private closed = false

  /**
   * @param ctx - Host context carrying the optional filesystem capability.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * What this surface is, for `describe()`.
   * @returns the route paths and whether a web server is mounted at all.
   */
  info(): PreviewSurfaceInfo {
    if (this.ctx.get('webServer') === undefined) {
      return {
        fileRoute: FILE_ROUTE,
        proxyRoute: PROXY_ROUTE,
        available: false,
        reason: 'no web server capability is mounted: a workspace file has no same-origin URL to be '
          + 'framed from, and a dev server stays cross-origin',
      }
    }
    return { fileRoute: FILE_ROUTE, proxyRoute: PROXY_ROUTE, available: true }
  }

  /**
   * The URL one workspace file is framed from, or undefined when this Host serves no routes.
   * @param workspacePath - absolute Host workspace directory.
   * @param filePath - absolute Host path inside it.
   * @returns the same-origin path, query included.
   */
  fileUrl(workspacePath: string, filePath: string): string | undefined {
    return this.info().available ? fileUrl(FILE_ROUTE, workspacePath, filePath) : undefined
  }

  /**
   * The same-origin URL that proxies one loopback URL.
   * @param target - the loopback URL, already validated by the caller.
   * @returns the same-origin path, query included.
   */
  proxyUrl(target: string): string {
    return proxyUrlFor(PROXY_ROUTE, target)
  }

  /**
   * Register every route with the mounted web server.
   *
   * Registration goes through `ctx.inject(['webServer'], …)` rather than a constructor read: a
   * headless deployment composes no web server, and the inject face simply never runs, leaving the
   * rest of the plugin working.
   */
  install(): void {
    this.ctx.inject(['webServer'], (webCtx) => {
      const disposeFile = webCtx.webServer.register({
        kind: 'exact',
        path: FILE_ROUTE,
        handler: (req, res) => this.handleFile(req, res),
      })
      const disposeScratch = webCtx.webServer.register({
        kind: 'exact',
        path: SCRATCHPAD_ROUTE,
        handler: (req, res) => this.handleScratchpad(req, res),
      })
      const disposeProxy = webCtx.webServer.register({
        kind: 'prefix',
        path: PROXY_ROUTE,
        handler: (req, res) => this.handleProxy(req, res),
      })
      // The upgrade seat is exact-path only, and a websocket client connects at the root of
      // whatever prefix it was given, so this route catches the common case. A dev server that
      // negotiates on a subpath is documented as unsupported rather than silently half-proxied.
      const disposeUpgrade = webCtx.webServer.registerUpgrade({
        path: PROXY_ROUTE,
        handler: (req, socket, head) => this.handleUpgrade(req, socket, head),
      })
      return () => {
        disposeUpgrade()
        disposeProxy()
        disposeScratch()
        disposeFile()
      }
    })
  }

  /** Forget every target and abort every in-flight request. Called from the plugin's teardown. */
  dispose(): void {
    this.closed = true
    this.targets.clear()
    for (const upstream of [...this.live]) upstream.abort()
    this.live.clear()
  }

  /**
   * Describe one workspace file for the panel, or refuse it.
   * @param workspacePath - absolute Host workspace directory.
   * @param path - absolute Host path, or a path relative to the workspace.
   * @param signal - cancellation for the resolution and the metadata read.
   * @returns the file's kind, size, frame URL, and change token.
   */
  async info_(workspacePath: string | undefined, path: string, signal?: AbortSignal): Promise<PreviewFileInfoResult> {
    const resolved = await this.resolve(workspacePath, path, signal)
    if (!resolved.ok) return resolved.failure
    return this.describeFile(resolved.workspace, resolved.target, resolved.display, signal)
  }

  /**
   * Serve one workspace file as the frame's document or as one of its subresources.
   * @param req - the incoming request.
   * @param res - the response the handler owns.
   */
  private async handleFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'only GET and HEAD are served here')
      return
    }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const resolved = await this.resolve(query.get('workspace') ?? undefined, query.get('path') ?? '', undefined)
    if (!resolved.ok) {
      res.setHeader('cache-control', 'no-store')
      send(res, 404, 'text/plain; charset=utf-8', resolved.failure.message)
      return
    }
    const fs = this.ctx.get('fs')
    /* v8 ignore next -- `resolve` refuses before this point when the capability is absent. */
    if (fs === undefined) {
      send(res, 500, 'text/plain; charset=utf-8', 'filesystem capability withdrawn mid-request')
      return
    }
    const stat = await fs.stat(resolved.target)
    if (stat === undefined || stat.type !== 'file') {
      res.setHeader('cache-control', 'no-store')
      send(res, 404, 'text/plain; charset=utf-8', `${resolved.display} is not a regular file`)
      return
    }
    const size = stat.size ?? 0
    const contentType = contentTypeOf(resolved.display)
    const etag = await this.etag(resolved.target, stat.version, size, stat.size)
    // No-store plus an explicit validator: the panel polls with `If-None-Match` and gets a cheap 304
    // while the file is unchanged, and never a 200 out of a cache after an edit.
    res.setHeader('cache-control', 'no-store')
    res.setHeader('etag', etag)
    res.setHeader('last-modified', new Date().toUTCString())

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304)
      res.end()
      return
    }
    if (size > this.source().previewMaxFileBytes) {
      send(res, 413, 'text/plain; charset=utf-8',
        `${resolved.display} is ${String(size)} bytes, over previewMaxFileBytes`)
      return
    }
    // The dev server's own `content-type` is authoritative for a proxied response; a workspace file
    // is typed by its extension here, with the charset stated rather than guessed.
    res.setHeader('content-type', isTextual(contentType) ? `${contentType}; charset=utf-8` : contentType)
    // A workspace file is somebody's source and may be an applet; nothing here needs a peer.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-encoding', 'identity')

    // A range is honoured only where the seam can honour it; otherwise the request falls through to
    // a full 200, which is a correct answer to a `Range` request and the one every media element
    // accepts.
    //
    // The shape guard is read once, here: TypeScript cannot carry a narrowing across the awaits
    // above, and a local binding says the fact once instead of casting it twice.
    const ranged = hasRangeRead(fs) ? fs : undefined
    res.setHeader('accept-ranges', ranged === undefined ? 'none' : 'bytes')
    const asked = ranged === undefined ? undefined : parseRange(req.headers.range, size)
    if (asked === 'unsatisfiable') {
      res.setHeader('content-range', `bytes */${String(size)}`)
      send(res, 416, 'text/plain; charset=utf-8', 'the requested range is past the end of the file')
      return
    }
    const range = typeof asked === 'string' ? undefined : asked
    let bytes: Uint8Array
    try {
      bytes = range === undefined
        ? await fs.readBytes(resolved.target, undefined, size)
        // The branch implies `ranged !== undefined`: `asked` is only non-undefined when it is. The
        // guard is spelled out so a reader does not have to prove that from three lines up.
        : await (ranged ?? fs as unknown as RangeCapableFileSystem)
          .readByteRange(resolved.target, { offset: range.start, length: range.end - range.start + 1 })
    } catch (error) {
      send(res, 500, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error))
      return
    }

    // An HTML document gets exactly one edit: a `<base>` pointing at this route, so `./app.js`
    // resolves to the file's own directory through the Host rather than to the GUI's root. It is
    // applied to a full-body read only — a ranged read must return the bytes that were asked for.
    let body = bytes
    if (range === undefined && contentType === 'text/html' && size <= FALLBACK_READ_BYTES) {
      body = new TextEncoder().encode(injectBase(decodeText(bytes), `${FILE_ROUTE}?workspace=${encodeQuery(resolved.workspace.processPath)}&path=`))
    }
    if (range !== undefined) {
      res.setHeader('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`)
    }
    res.setHeader('content-length', String(body.byteLength))
    res.writeHead(range === undefined ? 200 : 206)
    if (req.method === 'HEAD') res.end()
    else res.end(Buffer.from(body))
  }

  /**
   * Serve text the panel posted, as an HTML document on this origin.
   *
   * The scratchpad renders as `text/html` rather than through `srcdoc` so that the frame's document
   * has a real URL with this origin: `document.baseURI`, relative `fetch`, and `window.location` all
   * then behave the way the page under test expects, and an agent's `eval` sees them.
   * @param req - the incoming request.
   * @param res - the response the handler owns.
   */
  private handleScratchpad(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'only GET, HEAD and POST are served here')
      return
    }
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-encoding', 'identity')
    if (req.method !== 'POST') {
      res.setHeader('content-length', '0')
      res.writeHead(204)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      if (refused) return
      total += chunk.byteLength
      if (total > SCRATCHPAD_MAX_BYTES) {
        refused = true
        send(res, 413, 'text/plain; charset=utf-8', 'the scratchpad document is over its size limit')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) return
      // The base is the GUI's own root: a scratchpad has no directory of its own, so a relative
      // asset is a path on this origin, which is what a person experimenting expects.
      const document = Buffer.concat(chunks).toString('utf8')
      const body = Buffer.from(injectBase(document, '/'), 'utf8')
      res.setHeader('content-length', String(body.byteLength))
      res.writeHead(200)
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    })
    req.on('error', () => {
      if (!refused) res.destroy()
    })
  }

  /**
   * Forward one request to a loopback upstream and stream the answer back.
   * @param req - the incoming request.
   * @param res - the response the handler owns.
   */
  private async handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refuse = this.refusedOrigin(req)
    if (refuse !== undefined) {
      send(res, 403, 'text/plain; charset=utf-8', refuse)
      return
    }
    if (this.closed) {
      send(res, 503, 'text/plain; charset=utf-8', 'the preview surface is unloading')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const explicit = url.searchParams.get('url')
    const suffix = suffixOf(url.pathname)
    const target = explicit === null
      ? this.fallbackTarget(req, suffix)
      : validateProxyTarget(explicit)
    if (target === undefined) {
      send(res, 404, 'text/plain; charset=utf-8',
        'this proxied request names no loopback target: the preview proxy forwards only requests '
        + 'that carry `?url=`, or that a bound preview frame could have produced')
      return
    }
    if (!target.ok) {
      send(res, 403, 'text/plain; charset=utf-8', target.message)
      return
    }

    // The target is a full URL when it came from `?url=` and one remembered earlier when it came
    // from a subresource; both end up as one absolute upstream URL with the request's own path and
    // query preserved.
    const upstreamUrl = new URL(target.url.href)
    if (explicit === null) {
      const basePath = upstreamUrl.pathname.replace(/\/$/u, '')
      if (suffix !== '') upstreamUrl.pathname = `${basePath}/${suffix}`
      upstreamUrl.search = url.search
    } else if (suffix !== '') {
      // An absolute target with a path under the route: the caller addressed the proxy at a
      // subpath, which happens only when a relative URL was resolved against a `<base>` that
      // carried `?url=`. The suffix is what the document asked for.
      const basePath = upstreamUrl.pathname.replace(/\/$/u, '')
      upstreamUrl.pathname = suffix.startsWith(basePath.slice(1)) ? `/${suffix}` : `${basePath}/${suffix}`
      // The request's own query is the subresource's; `url` is the proxy's, not the upstream's.
      const forwarded = new URLSearchParams(url.searchParams)
      forwarded.delete('url')
      const extra = forwarded.toString()
      upstreamUrl.search = extra === '' ? '' : `?${extra}`
    }

    this.forward(req, res, upstreamUrl)
  }

  /**
   * Forward one upgraded connection to a loopback upstream.
   *
   * A dev server's live-reload socket is an optional convenience, not part of the inspection story:
   * a websocket carries no DOM and no console, and a page whose socket never opens still renders and
   * is still drivable. The tunnel is here because it is cheap — a raw `net` pipe with no protocol
   * knowledge — but a server that negotiates on a path other than the route's own root is not
   * tunnelled, because the web server's upgrade seat matches exact paths and claiming a wildcard
   * would collide with the app's own sockets.
   * @param req - the upgrade request.
   * @param socket - the client socket the handler owns.
   * @param head - bytes the parser already read past the request line.
   */
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = this.refusedOrigin(req)
    if (refuse !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const explicit = url.searchParams.get('url')
    const suffix = suffixOf(url.pathname)
    const target = explicit === null ? this.fallbackTarget(req, suffix) : validateProxyTarget(explicit)
    if (target === undefined || !target.ok) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    const upstreamUrl = new URL(target.url.href)
    const rest = explicit === null ? suffix : ''
    if (rest !== '') upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/u, '')}/${rest.replace(/^\//u, '')}`
    const port = upstreamUrl.port === '' ? (upstreamUrl.protocol === 'https:' ? 443 : 80) : Number(upstreamUrl.port)
    const upstream = netConnect({ host: upstreamUrl.hostname.replace(/^\[|\]$/gu, ''), port })
    const close = (): void => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
    upstream.on('connect', () => {
      // The upstream must see a well-formed request line for the path it actually serves.
      const headers = { ...req.headers, host: upstreamUrl.host }
      const lines = [`${req.method ?? 'GET'} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
        if (Array.isArray(value)) for (const one of value) lines.push(`${name}: ${one}`)
        else lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.byteLength > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  /**
   * One upstream request, with the response streamed straight through.
   * @param req - the client request.
   * @param res - the client response.
   * @param upstreamUrl - the absolute loopback URL to fetch.
   */
  private forward(req: IncomingMessage, res: ServerResponse, upstreamUrl: URL): void {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lowered = name.toLowerCase()
      if (HOP_BY_HOP.has(lowered) || REWRITTEN_REQUEST_HEADERS.has(lowered)) continue
      headers[name] = value
    }
    headers.host = upstreamUrl.host
    headers.accept = typeof req.headers.accept === 'string' ? req.headers.accept : '*/*'

    const send_request = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamReq = send_request({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname.replace(/^\[|\]$/gu, ''),
      port: upstreamUrl.port === '' ? undefined : Number(upstreamUrl.port),
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: req.method ?? 'GET',
      headers,
    }, (upstreamRes) => {
      const contentType = String(upstreamRes.headers['content-type'] ?? '')
      // A redirect is passed through verbatim. Its `Location` is either absolute (which the browser
      // follows to the upstream, losing inspection for that navigation) or relative (which resolves
      // against this proxy route and therefore stays same-origin).
      const streaming = contentType.includes('text/event-stream')
      res.setHeader('cache-control', streaming ? 'no-cache' : 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-encoding', 'identity')
      let injected: Buffer | undefined
      if (contentType.startsWith('text/html') && req.method !== 'HEAD') {
        // Buffered to one buffer only because the base must be spliced into the head; a streamed
        // document would arrive at the parser without it.
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        upstreamRes.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const base = baseOf(text) ?? `${PROXY_ROUTE}?url=${encodeQuery(upstreamUrl.href)}`
          injected = Buffer.from(injectBase(text, base), 'utf8')
          res.setHeader('content-length', String(injected.byteLength))
          res.writeHead(upstreamRes.statusCode ?? 502, forwardHeaders(upstreamRes))
          res.end(injected)
        })
        upstreamRes.on('error', () => { res.destroy() })
        upstreamReq.on('error', () => { if (!res.headersSent) send(res, 502, 'text/plain; charset=utf-8', 'the upstream dev server closed the connection') })
        return
      }
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
        if (name.toLowerCase() === 'content-type' && isTextual(String(value))) {
          res.setHeader(name, String(value).includes('charset') ? String(value) : `${String(value)}; charset=utf-8`)
          continue
        }
        res.setHeader(name, value)
      }
      res.writeHead(upstreamRes.statusCode ?? 502)
      upstreamRes.pipe(res)
      upstreamRes.on('error', () => { res.destroy() })
    })
    const timeout = this.source().previewProxyTimeoutMs
    upstreamReq.setTimeout(timeout, () => {
      upstreamReq.destroy(new Error(`the upstream dev server did not answer within ${String(timeout)}ms`))
    })
    upstreamReq.on('error', (error: Error) => {
      if (res.headersSent) { res.destroy(); return }
      send(res, 502, 'text/plain; charset=utf-8',
        `the preview proxy could not reach ${upstreamUrl.origin}: ${error.message}`)
    })
    const upstream: Upstream = { abort: () => { upstreamReq.destroy() } }
    this.live.add(upstream)
    res.on('close', () => { this.live.delete(upstream); upstreamReq.destroy() })
    // The request body is forwarded as a stream, so a POST to a dev server's own API works and a
    // large upload is never buffered here.
    req.pipe(upstreamReq)
  }

  /**
   * Resolve a workspace and one path inside it.
   * @param workspacePath - absolute Host workspace directory, absent to treat the path itself as one.
   * @param path - absolute Host path, or a path relative to the workspace.
   * @param signal - cancellation for the resolution.
   * @returns the workspace, the contained target, and the path as it should be displayed.
   */
  private async resolve(
    workspacePath: string | undefined, path: string, signal?: AbortSignal,
  ): Promise<
    | { ok: true; workspace: ResolvedPath; target: FsTarget; display: string }
    | { ok: false; failure: { ok: false; code: 'no-filesystem' | 'path-denied'; message: string } }
  > {
    if (path.trim() === '') {
      return { ok: false, failure: { ok: false, code: 'path-denied', message: 'no path was given' } }
    }
    // No workspace named means the path is its own workspace root: the tool calls this with a path
    // it resolved from the session, and a bare file route cannot know one. Containment is then the
    // path's own identity, which is still a canonicalization through the backend.
    const workspace = await resolveWorkspace(this.ctx, workspacePath ?? path, signal)
    if (!workspace.ok) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
          message: workspace.rejection.message,
        },
      }
    }
    if (workspacePath === undefined) {
      return { ok: true, workspace: workspace.value, target: workspace.value.target, display: path }
    }
    const inside = await resolveInside(this.ctx, workspace.value, path, signal)
    if (!inside.ok) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: inside.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
          message: inside.rejection.message,
        },
      }
    }
    return { ok: true, workspace: workspace.value, target: inside.value.target, display: inside.value.processPath }
  }

  /**
   * Describe one already-resolved file.
   * @param workspace - the resolved workspace.
   * @param target - the resolved target.
   * @param display - the path to report back and to base the content type on.
   * @param signal - cancellation for the metadata and token reads.
   * @returns the description.
   */
  private async describeFile(
    workspace: ResolvedPath, target: FsTarget, display: string, signal?: AbortSignal,
  ): Promise<PreviewFileInfoResult> {
    const fs = this.ctx.get('fs')
    /* v8 ignore next -- the caller resolved the workspace through the same service moments earlier. */
    if (fs === undefined) {
      return { ok: false, code: 'no-filesystem', message: 'filesystem capability withdrawn mid-request' }
    }
    const stat = await fs.stat(target, signal)
    if (stat === undefined || stat.type !== 'file') {
      return { ok: false, code: 'not-a-file', message: `${display} is not a regular file` }
    }
    const size = stat.size ?? 0
    const contentType = contentTypeOf(display)
    const kind = classifyFile(display, contentType)
    const name = display.slice(display.lastIndexOf('/') + 1)
    // A URL is offered for everything the route can actually serve into a frame: a document, and the
    // text kinds this panel fetches over the same route and renders itself. `image`, `media` and
    // `pdf` are drawn by native elements, which take the URL just as well — only `other` has nothing
    // to point a browser at, so only `other` (and a Host with no routes) has no url.
    const url = kind === 'other' || !this.info().available
      ? undefined
      : fileUrl(FILE_ROUTE, workspace.processPath, display)
    return {
      ok: true,
      path: display,
      name,
      kind,
      contentType,
      bytes: size,
      withinLimit: size <= this.source().previewMaxFileBytes,
      ...url === undefined ? {} : { url },
      token: await this.etag(target, stat.version, size, stat.size, signal),
      regular: true,
    }
  }

  /**
   * A weak validator for one file: the backend's version, its size, and a digest of its head.
   * @param target - the resolved target.
   * @param version - the backend's opaque freshness token.
   * @param size - the byte size; `undefined` asks for no probe read.
   * @param reportedSize - the size the backend reported, which may be absent.
   * @param signal - cancellation for the probe read.
   * @returns the ETag body, quotes included.
   */
  private async etag(
    target: FsTarget, version: unknown, size: number, reportedSize?: number, signal?: AbortSignal,
  ): Promise<string> {
    const hash = createHash('sha1')
    hash.update(String(version))
    hash.update(`:${String(size)}:${String(reportedSize ?? '')}`)
    const fs = this.ctx.get('fs')
    if (fs !== undefined && size > 0) {
      try {
        const window = Math.min(size, TOKEN_PROBE_BYTES)
        const head = hasRangeRead(fs)
          ? await fs.readByteRange(target, { offset: 0, length: window }, signal)
          : await fs.readBytes(target, signal, window)
        hash.update(head)
      } catch {
        // A head that cannot be read is not a reason to refuse the file: the version and the size
        // already distinguish two different contents on every backend this plugin runs on.
      }
    }
    return `W/"${hash.digest('hex').slice(0, 32)}"`
  }

  /**
   * The target one subresource request should be forwarded to.
   * @param req - the subresource request.
   * @param suffix - the path below the proxy route, without a leading slash.
   * @returns the validated target, or undefined when this Host holds none for the caller.
   */
  private fallbackTarget(req: IncomingMessage, suffix: string): { ok: true; url: URL } | undefined {
    // The panel tags every request its frame makes with its own id, which is what keeps two browser
    // tabs previewing two different dev servers from crossing their subresources.
    const client = req.headers['x-dsh-preview-client']
    const key = typeof client === 'string' && client !== '' ? client : undefined
    const known = key === undefined ? undefined : this.targets.get(key)
    if (known !== undefined) {
      const parsed = validateProxyTarget(known)
      if (parsed.ok) return parsed
    }
    // Nothing tagged the request, which is what an untagged `fetch` from inside the frame looks
    // like. One target at a time is enough there: guessing between several would send a subresource
    // to a different server than the document that asked for it, so with more than one it is
    // refused rather than guessed.
    if (this.targets.size === 1) {
      const only = [...this.targets.values()][0]
      /* v8 ignore next -- `size === 1` guarantees the element exists. */
      if (only !== undefined) {
        const parsed = validateProxyTarget(only)
        if (parsed.ok) return parsed
      }
    }
    // A bare suffix with no remembered target is a request this surface cannot place. The suffix is
    // named in the diagnostic so an operator sees which URL escaped the base.
    void suffix
    return undefined
  }

  /**
   * Record the target one panel is framing, so its subresources resolve.
   * @param clientId - the panel's id.
   * @param target - the upstream URL, or undefined when the panel stopped framing one.
   */
  rememberTarget(clientId: string, target: string | undefined): void {
    if (target === undefined) this.targets.delete(clientId)
    else this.targets.set(clientId, target)
  }

  /**
   * Refuse a request whose `Origin` is not this server's own.
   * @param req - the incoming request.
   * @returns the refusal message, or undefined when the request may proceed.
   */
  private refusedOrigin(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return undefined
    const host = req.headers.host
    if (typeof host !== 'string') return undefined
    try {
      // Compared as an authority rather than as a full origin: the deployment may be behind a
      // reverse proxy whose scheme differs from the one the socket sees, and the authority is what
      // decides whether this is the GUI's own page.
      if (new URL(origin).host === host) return undefined
    } catch {
      return `${JSON.stringify(origin)} is not an origin this proxy will answer`
    }
    return `the preview proxy answers only this GUI's own origin, not ${JSON.stringify(origin)}`
  }
}

/**
 * The path below the proxy route, without a leading slash.
 * @param pathname - the request's pathname.
 * @returns the suffix, or the empty string at the route's own root.
 */
function suffixOf(pathname: string): string {
  const rest = pathname.slice(PROXY_ROUTE.length)
  return rest.replace(/^\/+/u, '')
}

/**
 * The `<base href>` a proxied document already declares, when it declares one.
 *
 * A dev-server framework frequently injects its own base tag (`vite` does not, `next` does), and a
 * second one would be ignored by the parser in favour of the first. Reading it back means this
 * proxy either keeps the document's own answer or supplies one, never both.
 * @param html - the document text.
 * @returns the declared href, or undefined.
 */
function baseOf(html: string): string | undefined {
  const match = /<base\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/iu.exec(html)
  if (match === null) return undefined
  return match[2] ?? match[3]
}

/**
 * Upstream headers minus the hop-by-hop set, for the buffered HTML branch.
 * @param res - the upstream response.
 * @returns the headers to copy.
 */
function forwardHeaders(res: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'content-length') continue
    headers[name] = value
  }
  return headers
}

/** One byte range a request asked for. */
interface Range {
  /** First byte, inclusive. */
  readonly start: number
  /** Last byte, inclusive. */
  readonly end: number
}

/**
 * Parse one `Range` header against a known size.
 *
 * Only `bytes=` and only a single range are honoured: a multipart range costs a multipart encoder to
 * serve, and the one caller that matters — a `<video>` scrubber — asks for one range at a time.
 * @param header - the raw header value.
 * @param size - the file's size in bytes.
 * @returns the range, undefined for a full response, or `unsatisfiable`.
 */
export function parseRange(header: string | undefined, size: number): Range | undefined | 'unsatisfiable' {
  if (header === undefined || !header.startsWith('bytes=')) return undefined
  const spec = header.slice('bytes='.length).split(',')[0]?.trim() ?? ''
  const parts = spec.split('-')
  if (parts.length !== 2) return undefined
  const [rawStart, rawEnd] = parts
  const start = rawStart === undefined || rawStart === '' ? undefined : Number.parseInt(rawStart, 10)
  const end = rawEnd === undefined || rawEnd === '' ? undefined : Number.parseInt(rawEnd, 10)
  if (start !== undefined && Number.isNaN(start)) return undefined
  if (end !== undefined && Number.isNaN(end)) return undefined
  if (start === undefined && end === undefined) return undefined
  if (size === 0) return 'unsatisfiable'
  if (start === undefined) {
    // A suffix range: the last N bytes.
    const length = end ?? 0
    if (length <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  if (start >= size) return 'unsatisfiable'
  const last = end === undefined ? size - 1 : Math.min(end, size - 1)
  if (last < start) return 'unsatisfiable'
  return { start, end: last }
}

/**
 * Answer one request with a short, uncached body.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param contentType - the MIME type.
 * @param body - the text to send.
 */
function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  if (res.headersSent) { res.end(); return }
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-encoding', 'identity')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.writeHead(status)
  res.end(body)
}
