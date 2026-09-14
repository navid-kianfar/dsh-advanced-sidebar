import { describe, expect, it } from 'vitest'
import {
  classifyFile, contentTypeOf, decodeText, extensionOf, fileUrl, frameUrlFor, injectBase,
  isLoopbackHost, isTextual, parseHttpUrl, proxyUrlFor, validateProxyTarget,
} from '../src/host/preview-content.ts'

/**
 * These are the decisions the same-origin preview routes are built on, and two of them are security
 * boundaries rather than conveniences: which hosts the reverse proxy will fetch, and which file
 * types the browser is handed a live document for. Pure functions with no `ctx`, so each rule can be
 * stated in one line here rather than inferred from a request handler.
 */

describe('content types', () => {
  it('reads an extension, and refuses to read a hidden file name as one', () => {
    expect(extensionOf('/w/src/app.TSX')).toBe('tsx')
    expect(extensionOf('/w/.env')).toBe('')
    expect(extensionOf('/w/Makefile')).toBe('')
    expect(extensionOf('/w/archive.tar.gz')).toBe('gz')
  })

  it('maps the extensions a frame actually renders', () => {
    expect(contentTypeOf('index.html')).toBe('text/html')
    expect(contentTypeOf('app.js')).toBe('text/javascript')
    expect(contentTypeOf('styles.css')).toBe('text/css')
    expect(contentTypeOf('logo.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('clip.webm')).toBe('video/webm')
    expect(contentTypeOf('track.m4a')).toBe('audio/mp4')
    expect(contentTypeOf('report.pdf')).toBe('application/pdf')
  })

  it('falls back to octet-stream rather than guessing', () => {
    expect(contentTypeOf('blob')).toBe('application/octet-stream')
    expect(contentTypeOf('thing.unknownext')).toBe('application/octet-stream')
  })

  it('states a charset for textual types only', () => {
    expect(isTextual('text/html')).toBe(true)
    expect(isTextual('application/json')).toBe(true)
    expect(isTextual('image/svg+xml')).toBe(true)
    expect(isTextual('image/png')).toBe(false)
    expect(isTextual('application/pdf')).toBe(false)
  })
})

describe('preview kinds', () => {
  it('frames a document, including an SVG one', () => {
    expect(classifyFile('index.html')).toBe('iframe')
    expect(classifyFile('page.htm')).toBe('iframe')
    expect(classifyFile('icon.svg')).toBe('iframe')
  })

  it('reads Markdown itself rather than framing it', () => {
    expect(classifyFile('README.md')).toBe('markdown')
    expect(classifyFile('notes.markdown')).toBe('markdown')
  })

  it('hands images and media to the browser elements', () => {
    expect(classifyFile('shot.png')).toBe('image')
    expect(classifyFile('shot.avif')).toBe('image')
    expect(classifyFile('clip.mp4')).toBe('media')
    expect(classifyFile('song.flac')).toBe('media')
    expect(classifyFile('report.pdf')).toBe('pdf')
  })

  it('reads a text file whose extension says nothing, and refuses anything else', () => {
    expect(classifyFile('NOTES', 'text/plain')).toBe('text')
    // An extensionless binary has no text MIME type either, so it lands on the honest state.
    expect(classifyFile('blob', 'application/octet-stream')).toBe('other')
  })
})

describe('URL admission', () => {
  it('accepts only http and https', () => {
    expect(parseHttpUrl('http://127.0.0.1:5173/').ok).toBe(true)
    expect(parseHttpUrl('https://example.com/x').ok).toBe(true)
    for (const refused of ['file:///etc/passwd', 'data:text/html,<h1>x', 'javascript:alert(1)', 'not a url']) {
      expect(parseHttpUrl(refused).ok, refused).toBe(false)
    }
  })

  it('recognises exactly the loopback literals', () => {
    for (const host of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://127.9.9.9:1', 'http://[::1]:8080']) {
      expect(isLoopbackHost(new URL(host)), host).toBe(true)
    }
    for (const host of [
      'http://10.0.0.5', 'http://192.168.1.1', 'http://128.0.0.1', 'http://0.0.0.0',
      'http://localhost.evil.com', 'http://169.254.169.254/latest/meta-data',
      'https://example.com', 'http://[::ffff:127.0.0.1]',
    ]) {
      expect(isLoopbackHost(new URL(host)), host).toBe(false)
    }
  })

  it('refuses a non-loopback proxy target with a sentence naming the host', () => {
    const refused = validateProxyTarget('http://169.254.169.254/latest/meta-data')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('169.254.169.254')
    expect(validateProxyTarget('http://127.0.0.1:5173/app').ok).toBe(true)
  })
})

describe('frame URLs', () => {
  it('routes a loopback URL through the proxy and claims same-origin', () => {
    const framed = frameUrlFor('/advanced-sidebar/preview-proxy', 'http://127.0.0.1:5173/app?x=1')
    expect(framed.sameOrigin).toBe(true)
    expect(framed.src.startsWith('/advanced-sidebar/preview-proxy?url=')).toBe(true)
    expect(decodeURIComponent(framed.src)).toContain('http://127.0.0.1:5173/app?x=1')
  })

  it('leaves a public URL exactly as typed and says it is not same-origin', () => {
    const framed = frameUrlFor('/p', 'https://example.com/a')
    expect(framed).toEqual({ src: 'https://example.com/a', sameOrigin: false })
  })

  it('encodes both halves of a file URL', () => {
    const url = fileUrl('/advanced-sidebar/preview-file', '/w/a b', '/w/a b/index.html')
    expect(url).toBe('/advanced-sidebar/preview-file?workspace=%2Fw%2Fa%20b&path=%2Fw%2Fa%20b%2Findex.html')
    expect(proxyUrlFor('/p', 'http://127.0.0.1:1/')).toBe('/p?url=http%3A%2F%2F127.0.0.1%3A1%2F')
  })
})

describe('HTML base injection', () => {
  it('inserts one base into an existing head', () => {
    const out = injectBase('<!doctype html><html><head><title>t</title></head><body></body></html>', '/p?x=1')
    expect(out).toContain('<head><!--advanced-sidebar:base--><base href="/p?x=1"><title>t</title>')
    expect(out.match(/<base /gu)).toHaveLength(1)
  })

  it('places the base in a head-less document so the parser files it correctly', () => {
    const out = injectBase('<html><body>hi</body></html>', '/p')
    expect(out.startsWith('<html><!--advanced-sidebar:base--><base href="/p">')).toBe(true)
    const bare = injectBase('<p>hi</p>', '/p')
    expect(bare.startsWith('<!--advanced-sidebar:base--><base href="/p">')).toBe(true)
  })

  it('does not mistake a <header> for a head', () => {
    const out = injectBase('<html><body><header>h</header></body></html>', '/p')
    // The base must land at the front of the document, where the parser puts an implied head — not
    // inside the `<header>`, which is where a substring match on `<head` would have spliced it.
    expect(out.startsWith('<html><!--advanced-sidebar:base--><base href="/p">')).toBe(true)
  })

  it('escapes a quote in the href rather than breaking out of the attribute', () => {
    const out = injectBase('<head></head>', '/p?q="><script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('decodes a byte window without failing on a cut sequence', () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xe2, 0x82])
    expect(decodeText(bytes).startsWith('hi')).toBe(true)
  })
})
