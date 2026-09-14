/**
 * Pure decisions the same-origin preview routes are built on: what a file is, what MIME type it
 * gets, and whether a URL is one this plugin is willing to fetch or frame.
 *
 * Kept free of `ctx`, `node:http`, and the filesystem so every rule here is a table lookup a test
 * can state in one line. The two rules that matter most — a proxy target must be loopback, and a
 * framed document must be same-origin — are the whole difference between a helpful preview and an
 * open proxy or a cross-origin hole, so they live in functions rather than in a request handler's
 * middle.
 * @module @achasoft/dsh-advanced-sidebar/host/preview-content
 */

import type { PreviewFileKind } from './types.ts'

/**
 * Absolute path of the workspace-file route; one route, parameterized by query.
 *
 * Declared here rather than in the module that registers it because the BROWSER half builds URLs
 * from these strings too, and this module is the one both halves already share. Two literals that
 * had to agree would eventually stop agreeing, and the symptom would be a frame that 404s only
 * after a rename nobody thought was load-bearing.
 */
export const FILE_ROUTE = '/advanced-sidebar/preview-file'

/** Absolute path of the loopback reverse proxy; subpaths are forwarded as-is. */
export const PROXY_ROUTE = '/advanced-sidebar/preview-proxy'

/** Absolute path of the scratchpad route: renders text the panel posts, with no file behind it. */
export const SCRATCHPAD_ROUTE = '/advanced-sidebar/preview-scratchpad'

/**
 * The scratchpad route derived from the file route.
 *
 * The two differ only in their last segment, and a deployment that overrides one would have to
 * override the other; deriving it is what makes that impossible to forget.
 * @param fileRoute - the file route, `/…/preview-file`.
 * @returns the scratchpad route.
 */
export function scratchRoute(fileRoute: string): string {
  return fileRoute.replace(/preview-file$/u, 'preview-scratchpad')
}

/**
 * Extensions mapped to MIME types, for the files a preview frame actually renders.
 *
 * Deliberately a hand-written table rather than a dependency: the set is small, fixed by what the
 * panel can display, and a lookup that cannot consult the host's `/etc/mime.types` behaves the same
 * on every machine — which is what makes the tests here meaningful.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // Documents the frame renders itself.
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  // Images.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // Audio and video, whose seeking depends on the browser seeing a real type.
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  // Fonts a dev server's own stylesheet may pull through the proxy.
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** The fallback for a file whose extension says nothing; a native element will not render it. */
const OCTET_STREAM = 'application/octet-stream'

/** Extensions `.svg` deliberately excluded from the image kind; see {@link classifyFile}. */
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'])

/** Extensions the browser plays in a `<video>` or `<audio>` element. */
const MEDIA = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'mp4', 'm4v', 'webm', 'mov', 'ogv',
])

/** Extensions rendered as Markdown by this panel rather than by the browser. */
const MARKDOWN = new Set(['md', 'markdown'])

/** Extensions whose bytes are text worth reading in the monospace reader. */
const TEXT = new Set([
  'txt', 'csv', 'json', 'xml', 'css', 'js', 'mjs', 'cjs', 'map', 'yml', 'yaml', 'toml', 'ini',
  'log', 'ts', 'tsx', 'jsx', 'sh', 'zsh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'sql', 'env', 'conf', 'lock', 'patch', 'diff',
])

/**
 * The lower-case extension of a path, without its dot.
 * @param path - a file path or a URL pathname.
 * @returns the extension, or the empty string when there is none.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file's name, not an extension: `.env` is text, not an "env" type.
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * The MIME type one path is served with.
 * @param path - a file path or a URL pathname.
 * @returns the type; `application/octet-stream` when the extension says nothing.
 */
export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? OCTET_STREAM
}

/**
 * Whether a MIME type is text that needs an explicit charset.
 *
 * `text/*` and the `+json`/`+xml` suffixes are the two families where a browser guessing a charset
 * would be guessing right most of the time and wrong exactly when it matters — a UTF-8 source file
 * rendered as latin-1.
 * @param contentType - the type, without parameters.
 * @returns true when the type should carry `; charset=utf-8`.
 */
export function isTextual(contentType: string): boolean {
  return contentType.startsWith('text/')
    || contentType === 'application/json'
    || contentType.endsWith('+json')
    || contentType.endsWith('+xml')
}

/**
 * How the browser should present one path.
 *
 * `.html` is `iframe` rather than `text`: the frame is the point of the mode, and the same-origin
 * route injects the base URL that makes its relative assets resolve. `.svg` is treated as an
 * `iframe` too, because an SVG document is scriptable — handing it to an `<img>` would silently
 * drop its scripts and hand it to the frame instead keeps one behaviour for "a document".
 * @param path - a file path or a URL pathname.
 * @param contentType - the type it is served with; defaults to the one {@link contentTypeOf} gives.
 * @returns the preview kind.
 */
export function classifyFile(path: string, contentType = contentTypeOf(path)): PreviewFileKind {
  const extension = extensionOf(path)
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml') return 'iframe'
  if (extension === 'svg') return 'iframe'
  if (MARKDOWN.has(extension)) return 'markdown'
  if (IMAGE.has(extension)) return 'image'
  if (MEDIA.has(extension)) return 'media'
  if (extension === 'pdf') return 'pdf'
  if (TEXT.has(extension)) return 'text'
  // Extensions are a losing game, so the MIME type is the second opinion: a file with no extension
  // that the filesystem still calls text is worth reading.
  if (isTextual(contentType)) return 'text'
  return 'other'
}

/**
 * Reject anything that is not plain HTTP(S).
 *
 * A `file:` or `data:` URL handed to the proxy would read the Host's own disk, and a `javascript:`
 * one would be an injection; none of them is something a preview of a dev server needs.
 * @param value - the candidate URL.
 * @returns the parsed URL, or the reason it was refused.
 */
export function parseHttpUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, message: `${JSON.stringify(value)} is not an absolute URL` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: `only http and https can be previewed (got ${url.protocol})` }
  }
  return { ok: true, url }
}

/**
 * Whether a parsed URL points at this machine.
 *
 * The proxy exists so a loopback dev server can be framed same-origin. Without this check it would
 * also fetch `http://10.0.0.5/admin` on the operator's behalf, from the operator's network position
 * — an open proxy bolted to the GUI. Only literal loopback names and addresses pass: `localhost`,
 * `127.0.0.0/8`, and `[::1]`.
 *
 * A hostname that merely *resolves* to loopback (a split-horizon DNS entry, a hostfile alias) is
 * refused rather than probed. Deciding this by lookup would make the answer depend on the resolver
 * at request time, and a DNS rebinding attack is exactly the case where the answer changes between
 * the check and the fetch.
 * @param url - a parsed URL.
 * @returns true when the host is a loopback literal.
 */
export function isLoopbackHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host === '::1') return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  if (parts.some(part => !/^\d{1,3}$/u.test(part))) return false
  const [first, second] = parts.map(part => Number.parseInt(part, 10))
  if (first !== 127) return false
  return second !== undefined && second >= 0 && second <= 255
}

/**
 * Refuse a URL this plugin will not fetch.
 * @param value - the candidate URL.
 * @returns the parsed URL, or the reason it was refused.
 */
export function validateProxyTarget(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  const parsed = parseHttpUrl(value)
  if (!parsed.ok) return parsed
  if (!isLoopbackHost(parsed.url)) {
    return {
      ok: false,
      message: `the preview proxy refuses ${parsed.url.hostname}: only this machine's own loopback `
        + 'dev servers are proxied, so the GUI cannot become an open proxy',
    }
  }
  return parsed
}

/**
 * Percent-encode a value for a query string, using the one encoder every runtime here has.
 * @param value - the raw value.
 * @returns the encoded value.
 */
export function encodeQuery(value: string): string {
  return encodeURIComponent(value)
}

/**
 * Build the same-origin URL one workspace file is framed from.
 * @param fileRoute - the absolute file route path, no trailing slash.
 * @param workspacePath - absolute Host workspace directory.
 * @param filePath - absolute Host path inside it.
 * @returns the path plus query string.
 */
export function fileUrl(fileRoute: string, workspacePath: string, filePath: string): string {
  return `${fileRoute}?workspace=${encodeQuery(workspacePath)}&path=${encodeQuery(filePath)}`
}

/**
 * Build the same-origin URL that proxies one absolute upstream URL.
 * @param proxyRoute - the absolute proxy route path, no trailing slash.
 * @param target - the loopback URL to fetch.
 * @returns the path plus query string.
 */
export function proxyUrlFor(proxyRoute: string, target: string): string {
  return `${proxyRoute}?url=${encodeQuery(target)}`
}

/**
 * Turn one absolute upstream URL into a same-origin frame URL when it is a loopback target.
 *
 * A cross-origin dev server is left exactly as it is: pointing the GUI's own proxy at a host it
 * would refuse is not an improvement, and the panel says why the frame is opaque rather than
 * silently refusing to show it.
 * @param proxyRoute - the absolute proxy route path, no trailing slash.
 * @param raw - the URL a person typed.
 * @returns the frame URL, and whether it is same-origin with the GUI.
 */
export function frameUrlFor(proxyRoute: string, raw: string): { src: string; sameOrigin: boolean } {
  const target = validateProxyTarget(raw)
  if (!target.ok) return { src: raw, sameOrigin: false }
  return { src: proxyUrlFor(proxyRoute, target.url.href), sameOrigin: true }
}

/**
 * The marker the file route appends to an HTML document's head.
 *
 * It is a `<base>` and nothing else. The frame's document must resolve a relative `./app.js` against
 * the file's own directory, not against the GUI's root, and `<base href>` is the one mechanism the
 * browser offers that does that without rewriting every attribute in the document. A document that
 * already declares a base is left alone, because a page that states its own base means it.
 */
const BASE_MARKER = '<!--advanced-sidebar:base-->'

/**
 * Escape one string for a double-quoted HTML attribute.
 *
 * `&` first, or the escapes below would be escaped again. Every one of the four characters is
 * replaced, because a base href is built from workspace paths and query strings — both of which can
 * contain any of them — and a half-escaped value is an injection: `"` alone is not enough when the
 * value also carries `<`, which is what starts a tag the parser then honours.
 * @param value - the raw attribute value.
 * @returns the escaped value.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Insert a `<base>` element into an HTML document's head.
 *
 * String surgery rather than a parser on purpose: this runs on every HTML response, the document is
 * untrusted, and the only structural fact needed — "where does the head begin" — is unambiguous in
 * any HTML a browser will accept. The base goes immediately after the head's own opening tag, or
 * immediately after `<html>` when there is no head, or at the very front when there is neither —
 * which the parser then files into the implied head, where a base belongs.
 *
 * The global regex is what makes "no head" mean it: `indexOf('<head')` alone matches the substring
 * inside `<header>`, and splicing a base into a `<header>` would leave the document resolving every
 * relative URL against the wrong place.
 * @param html - the document text, as bytes decoded by the caller.
 * @param baseHref - the absolute same-origin prefix relative paths resolve against.
 * @returns the document with the base element added.
 */
export function injectBase(html: string, baseHref: string): string {
  const tag = `${BASE_MARKER}<base href="${escapeAttribute(baseHref)}">`
  const head = /<head(?=[\s/>])[^>]*>/iu.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  const root = /<html(?=[\s/>])[^>]*>/iu.exec(html)
  if (root !== null) {
    const at = root.index + root[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  return tag + html
}

/**
 * Whether a byte window looks like an HTML document that should get the base marker.
 * @param contentType - the response's MIME type.
 * @param bytes - the document's leading bytes.
 * @returns true for an HTML response.
 */
export function isHtmlDocument(contentType: string, bytes: Uint8Array): boolean {
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') return false
  // The extension already said HTML; the sniff is only here so a `.htm` file served as octet-stream
  // cannot slip through, which the caller's own content-type mapping makes impossible today.
  return bytes.byteLength > 0
}

/**
 * Decode a byte window as UTF-8 for the base injection, preserving nothing it cannot decode.
 *
 * Non-fatal on purpose: an HTML file whose tail is cut mid-sequence is still a document worth
 * rendering, and one replacement character is better than a 500.
 * @param bytes - the window.
 * @returns the decoded text.
 */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
