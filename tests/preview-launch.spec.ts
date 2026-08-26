import { describe, expect, it } from 'vitest'
import { mergeLaunches, parseLaunchFile } from '../src/host/preview.ts'
import type { PreviewLaunch } from '../src/host/types.ts'

/** The launch file as Claude Code writes one. */
const CLAUDE_FILE = JSON.stringify({
  version: '0.0.1',
  configurations: [
    { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 },
    { name: 'docs', runtimeExecutable: 'pnpm', runtimeArgs: ['docs:dev'], port: 5173, cwd: 'website' },
  ],
})

describe('parseLaunchFile', () => {
  it('reads Claude Code’s own launch-file vocabulary', () => {
    const parsed = parseLaunchFile(CLAUDE_FILE)
    expect('launches' in parsed && parsed.launches).toEqual([
      { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 },
      { name: 'docs', runtimeExecutable: 'pnpm', runtimeArgs: ['docs:dev'], port: 5173, cwd: 'website' },
    ])
  })

  it('keeps an attach-only row, which names a url and no command', () => {
    const parsed = parseLaunchFile(JSON.stringify({
      configurations: [{ name: 'staging', url: 'https://staging.example.com' }],
    }))
    expect('launches' in parsed && parsed.launches).toEqual([
      { name: 'staging', runtimeArgs: [], url: 'https://staging.example.com' },
    ])
  })

  it('carries an env block through', () => {
    const parsed = parseLaunchFile(JSON.stringify({
      configurations: [{ name: 'web', runtimeExecutable: 'npm', env: { NODE_ENV: 'development', PORT: 1 } }],
    }))
    // The numeric entry is dropped: the subprocess seam takes a string map, and coercing here would
    // hide a typo in the file rather than leaving it visible as a missing variable.
    expect('launches' in parsed && parsed.launches[0]?.env).toEqual({ NODE_ENV: 'development' })
  })

  it('reports invalid JSON rather than throwing', () => {
    const parsed = parseLaunchFile('{ not json')
    expect('error' in parsed && parsed.error).toContain('not valid JSON')
  })

  it('reports a file with no configurations array', () => {
    expect(parseLaunchFile('{"version":"1"}')).toEqual({ error: 'it carries no `configurations` array' })
    expect(parseLaunchFile('[]')).toEqual({ error: 'it carries no `configurations` array' })
    expect(parseLaunchFile('"a string"')).toEqual({ error: 'the top level is not an object' })
  })

  it('skips a row with no usable name instead of refusing the file', () => {
    const parsed = parseLaunchFile(JSON.stringify({
      configurations: [{ runtimeExecutable: 'npm' }, { name: '' }, { name: 'kept', runtimeExecutable: 'npm' }],
    }))
    expect('launches' in parsed && parsed.launches.map(entry => entry.name)).toEqual(['kept'])
  })

  it('ignores a port that is not a positive integer', () => {
    const parsed = parseLaunchFile(JSON.stringify({
      configurations: [{ name: 'a', runtimeExecutable: 'x', port: 0 }, { name: 'b', runtimeExecutable: 'x', port: '3000' }],
    }))
    expect('launches' in parsed && parsed.launches.every(entry => entry.port === undefined)).toBe(true)
  })

  it('drops non-string arguments rather than passing them to a process', () => {
    const parsed = parseLaunchFile(JSON.stringify({
      configurations: [{ name: 'a', runtimeExecutable: 'npm', runtimeArgs: ['run', 3, null, 'dev'] }],
    }))
    expect('launches' in parsed && parsed.launches[0]?.runtimeArgs).toEqual(['run', 'dev'])
  })
})

describe('mergeLaunches', () => {
  const file: PreviewLaunch[] = [{ name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 3000 }]
  const settings: PreviewLaunch[] = [
    { name: 'web', runtimeExecutable: 'yarn', runtimeArgs: ['dev'], port: 4000 },
    { name: 'storybook', runtimeExecutable: 'npm', runtimeArgs: ['run', 'sb'], port: 6006 },
  ]

  it('lists the file’s rows first', () => {
    expect(mergeLaunches(file, settings).map(entry => entry.launch.name)).toEqual(['web', 'storybook'])
  })

  it('lets the repository’s own file win a name collision', () => {
    const merged = mergeLaunches(file, settings)
    expect(merged[0]?.launch.runtimeExecutable).toBe('npm')
    expect(merged[0]?.origin).toBe('launch-json')
  })

  it('marks each row with where it came from', () => {
    expect(mergeLaunches(file, settings).map(entry => entry.origin)).toEqual(['launch-json', 'settings'])
  })

  it('keeps the settings rows when there is no file', () => {
    expect(mergeLaunches([], settings).map(entry => entry.launch.name)).toEqual(['web', 'storybook'])
  })

  it('drops a settings row duplicating another settings row', () => {
    const duplicated: PreviewLaunch[] = [...settings, { name: 'storybook', runtimeExecutable: 'other' }]
    expect(mergeLaunches([], duplicated)).toHaveLength(2)
  })
})
