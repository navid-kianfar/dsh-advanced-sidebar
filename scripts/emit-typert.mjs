/**
 * Emit `generated/` — the Typert RPC contract this package's browser half mounts.
 *
 * The harness's Typert generator reads a TypeScript program seeded from the harness's own
 * `tsconfig.host.json`, so it cannot run against a package outside that checkout. The artifact is
 * therefore authored here, to the exact format that generator emits, from the one spec below; the
 * endpoint list and every wire schema live in this file and nowhere else.
 *
 * Editing `src/host/types.ts` or the `@Remote` surface means editing this spec too. `pnpm test`
 * refuses a mismatch (`scripts/check-typert.mjs`), so the two cannot drift silently.
 *
 * Usage: node scripts/emit-typert.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { FINGERPRINT_FILE, fingerprint } from './typert-fingerprint.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = `${ROOT}generated`
const PKG = '@achasoft/dsh-advanced-sidebar'
const NS = 'advancedSidebar'
const SERVICE = 'advancedSidebar'
const TYPES = '../src/host/types.ts'
const SRC = 'src/host/index.ts'
const prefix = PKG.replace(/[^A-Za-z0-9]/g, '_')

const u = (...values) => `z.union([${values.map(v => `z.literal(${JSON.stringify(v)})`).join(', ')}])`
const capability = `z.object({
  'available': z.boolean().readonly(),
  'reason': z.string().readonly().optional(),
  'detail': z.string().readonly().optional(),
})`
const gitState = u('unmodified','added','modified','deleted','renamed','copied','typechange','untracked','ignored','conflicted')
const gitChange = `z.object({
  'path': z.string().readonly(),
  'oldPath': z.string().readonly().optional(),
  'index': ${gitState}.readonly(),
  'worktree': ${gitState}.readonly(),
  'untracked': z.boolean().readonly(),
  'conflicted': z.boolean().readonly(),
})`
const gitWrite = `z.object({
  'canStage': z.boolean().readonly(),
  'canCommit': z.boolean().readonly(),
  'canPush': z.boolean().readonly(),
  'canDraftMessage': z.boolean().readonly(),
  'author': z.string().readonly().optional(),
})`
const gitFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-filesystem','no-git','not-a-repository','git-failed','timeout','cancelled','path-denied','disabled','nothing-staged','empty-message','no-identity','no-upstream','detached-head','no-model','llm-failed')}.readonly(),
  'message': z.string().readonly(),
})`
const terminalFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-subprocess','no-filesystem','spawn-failed','unknown-terminal','path-denied','limit-reached','closed')}.readonly(),
  'message': z.string().readonly(),
})`
const taskFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-registry','disabled','unknown-session','unknown-task','registry-refused')}.readonly(),
  'message': z.string().readonly(),
})`
const settingsSection = `z.object({
  'showInSessionHeader': z.boolean().readonly(),
  'showChanges': z.boolean().readonly(),
  'showTerminal': z.boolean().readonly(),
  'showFiles': z.boolean().readonly(),
  'showTasks': z.boolean().readonly(),
  'showOpenIn': z.boolean().readonly(),
  'showArchive': z.boolean().readonly(),
  'showDelete': z.boolean().readonly(),
  'showPreview': z.boolean().readonly(),
  'panelWidth': z.number().readonly(),
  'confirmDelete': z.boolean().readonly(),
  'deleteMode': ${u('archive','purge')}.readonly(),
  'allowTaskKill': z.boolean().readonly(),
  'showTaskOutput': z.boolean().readonly(),
  'gitMaxFiles': z.number().readonly(),
  'gitDiffMaxBytes': z.number().readonly(),
  'gitTimeoutMs': z.number().readonly(),
  'gitCommitTimeoutMs': z.number().readonly(),
  'allowGitStaging': z.boolean().readonly(),
  'allowGitCommit': z.boolean().readonly(),
  'allowGitPush': z.boolean().readonly(),
  'gitPushTimeoutMs': z.number().readonly(),
  'allowCommitMessageDraft': z.boolean().readonly(),
  'commitMessagePrompt': z.string().readonly(),
  'commitMessageMaxBytes': z.number().readonly(),
  'terminalShell': z.string().readonly(),
  'terminalScrollback': z.number().readonly(),
  'maxTerminals': z.number().readonly(),
  'terminalGraceMs': z.number().readonly(),
  'filesMaxPreviewBytes': z.number().readonly(),
  'filesMaxEntries': z.number().readonly(),
  'filesShowHidden': z.boolean().readonly(),
  'editors': z.array(z.object({
  'id': z.string().readonly(),
  'label': z.string().readonly(),
  'command': z.string().readonly(),
  'args': z.array(z.string()),
})),
  'previews': z.array(z.object({
  'name': z.string(),
  'runtimeExecutable': z.string(),
  'runtimeArgs': z.array(z.string()),
  'port': z.number(),
  'url': z.string(),
  'cwd': z.string(),
})),
  'previewsFromLaunchFile': z.boolean().readonly(),
  'maxPreviews': z.number().readonly(),
  'previewReadyTimeoutMs': z.number().readonly(),
  'previewScrollback': z.number().readonly(),
  'previewGraceMs': z.number().readonly(),
  'previewMaxFileBytes': z.number().readonly(),
  'previewProxyTimeoutMs': z.number().readonly(),
  'previewCommandTimeoutMs': z.number().readonly(),
  'previewBindTtlMs': z.number().readonly(),
})`
const gitStatusSuccess = `z.object({
  'ok': z.literal(true).readonly(),
  'write': ${gitWrite}.readonly(),
  'repositoryRoot': z.string().readonly(),
  'prefix': z.string().readonly(),
  'branch': z.string().readonly().optional(),
  'upstream': z.string().readonly().optional(),
  'ahead': z.number().readonly(),
  'behind': z.number().readonly(),
  'detached': z.boolean().readonly(),
  'staged': z.array(${gitChange}).readonly(),
  'unstaged': z.array(${gitChange}).readonly(),
  'untracked': z.array(${gitChange}).readonly(),
  'conflicted': z.array(${gitChange}).readonly(),
  'truncated': z.boolean().readonly(),
  'readAt': z.number().readonly(),
})`
const previewFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-subprocess','no-filesystem','path-denied','unknown-server','not-startable','unavailable','spawn-failed','limit-reached','closed')}.readonly(),
  'message': z.string().readonly(),
})`
const previewServerView = `z.object({
  'serverId': z.string().readonly().optional(),
  'name': z.string().readonly(),
  'origin': ${u('launch-json','settings')}.readonly(),
  'startable': z.boolean().readonly(),
  'state': ${u('stopped','starting','ready','exited','failed')}.readonly(),
  'url': z.string().readonly().optional(),
  'port': z.number().readonly().optional(),
  'pid': z.number().readonly().optional(),
  'exitCode': z.union([z.number(), z.null()]).readonly().optional(),
  'detail': z.string().readonly().optional(),
  'startedAt': z.number().readonly().optional(),
})`
const readFileFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-filesystem','path-denied','not-a-file','read-failed')}.readonly(),
  'message': z.string().readonly(),
})`

/* --- same-origin preview serving and the agent channel ---------------------------------------- */

const previewFileInfoFields = `  'path': z.string().readonly(),
  'name': z.string().readonly(),
  'kind': ${u('iframe','markdown','image','media','pdf','text','other')}.readonly(),
  'contentType': z.string().readonly(),
  'bytes': z.number().readonly(),
  'withinLimit': z.boolean().readonly(),
  'url': z.string().readonly().optional(),
  'token': z.string().readonly(),
  'regular': z.boolean().readonly(),`

const previewFileFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-filesystem','path-denied','not-a-file','read-failed')}.readonly(),
  'message': z.string().readonly(),
})`

const previewBind = `z.object({
  'clientId': z.string().readonly(),
  'sessionId': z.string().readonly(),
  'mode': ${u('server','file','url','scratchpad')}.readonly(),
  'filePath': z.string().readonly().optional(),
  'workspacePath': z.string().readonly().optional(),
  'url': z.string().readonly().optional(),
  'inspectable': z.boolean().readonly(),
  'width': z.number().readonly(),
  'height': z.number().readonly(),
})`

const previewCommand = `z.object({
  'id': z.string().readonly(),
  'clientId': z.string().readonly(),
  'kind': ${u('open','dom','eval','console','click','input','reload','resize','close')}.readonly(),
  'selector': z.string().readonly().optional(),
  'expression': z.string().readonly().optional(),
  'cursor': z.number().readonly().optional(),
  'text': z.string().readonly().optional(),
  'key': z.string().readonly().optional(),
  'width': z.number().readonly().optional(),
  'height': z.number().readonly().optional(),
  'timeoutMs': z.number().readonly(),
})`

const previewMessage = `z.object({
  'commands': z.array(${previewCommand}).readonly(),
  'controls': z.array(z.object({
  'control': z.literal('open').readonly(),
  'open': z.object({
  'clientId': z.string().readonly(),
  'mode': ${u('server','file','url','scratchpad')}.readonly(),
  'filePath': z.string().readonly().optional(),
  'url': z.string().readonly().optional(),
  'workspacePath': z.string().readonly().optional(),
}).readonly(),
})).readonly(),
})`

const previewConsoleEntry = `z.object({
  'level': ${u('log','info','warn','error','uncaught','rejection')}.readonly(),
  'text': z.string().readonly(),
  'at': z.number().readonly(),
})`

const previewCommandResult = `z.union([z.object({
  'kind': z.literal('dom').readonly(),
  'selector': z.string().readonly(),
  'viewport': z.object({
  'width': z.number().readonly(),
  'height': z.number().readonly(),
}).readonly(),
  'nodes': z.array(z.object({
  'tag': z.string().readonly(),
  'selector': z.string().readonly(),
  'text': z.string().readonly(),
  'display': z.string().readonly(),
  'box': z.object({
  'x': z.number().readonly(),
  'y': z.number().readonly(),
  'width': z.number().readonly(),
  'height': z.number().readonly(),
}).readonly(),
  'depth': z.number().readonly(),
})).readonly(),
  'text': z.string().readonly(),
  'truncated': z.boolean().readonly(),
  'url': z.string().readonly(),
}), z.object({
  'kind': z.literal('eval').readonly(),
  'value': z.string().readonly(),
  'note': z.string().readonly().optional(),
  'truncated': z.boolean().readonly(),
}), z.object({
  'kind': z.literal('console').readonly(),
  'entries': z.array(${previewConsoleEntry}).readonly(),
  'cursor': z.number().readonly(),
  'lossy': z.boolean().readonly(),
}), z.object({
  'kind': z.literal('ack').readonly(),
  'detail': z.string().readonly(),
  'width': z.number().readonly().optional(),
  'height': z.number().readonly().optional(),
})])`

const previewPollFailure = `z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('no-subprocess','closed')}.readonly(),
  'message': z.string().readonly(),
})`

const previewSurfaceInfo = `z.object({
  'fileRoute': z.string().readonly(),
  'proxyRoute': z.string().readonly(),
  'available': z.boolean().readonly(),
  'reason': z.string().readonly().optional(),
})`

/** method -> { params: [{name, wire, type, schema}], cancellation, result: {type, schema} } */
const ENDPOINTS = [
  {
    method: 'deleteSession',
    params: [{ name: 'request', wire: 'request', type: 'DeleteSessionRequest', schema: `z.object({
  'sessionId': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'DeleteSessionResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'archived': z.boolean().readonly(),
  'purged': z.boolean().readonly(),
  'artifactPath': z.string().readonly().optional(),
  'purgeSkippedReason': z.string().readonly().optional(),
}), z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('disabled','no-registry','unknown-session','archive-failed','remove-failed')}.readonly(),
  'message': z.string().readonly(),
})])` },
  },
  {
    method: 'describe',
    params: [],
    cancellation: true,
    result: { type: 'AdvancedSidebarView', schema: `z.object({
  'git': ${capability}.readonly(),
  'terminal': ${capability}.readonly(),
  'files': ${capability}.readonly(),
  'preview': z.object({
  'available': z.boolean().readonly(),
  'reason': z.string().readonly().optional(),
  'detail': z.string().readonly().optional(),
  'running': z.number().readonly(),
  'surface': ${previewSurfaceInfo}.readonly().optional(),
}).readonly(),
  'tasks': z.object({
  'available': z.boolean().readonly(),
  'reason': z.string().readonly().optional(),
  'detail': z.string().readonly().optional(),
  'canKill': z.boolean().readonly(),
  'canReadOutput': z.boolean().readonly(),
}).readonly(),
  'openIn': z.array(z.object({
  'id': z.string().readonly(),
  'label': z.string().readonly(),
  'available': z.boolean().readonly(),
  'kind': ${u('reveal','command')}.readonly(),
})).readonly(),
  'deletion': z.object({
  'canPurge': z.boolean().readonly(),
  'mode': ${u('archive','purge')}.readonly(),
  'reason': z.string().readonly().optional(),
}).readonly(),
  'settings': ${settingsSection}.readonly(),
  'readAt': z.number().readonly(),
})` },
  },
  {
    method: 'gitDiff',
    params: [{ name: 'request', wire: 'request', type: 'GitDiffRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'path': z.string().readonly(),
  'staged': z.boolean().readonly(),
  'untracked': z.boolean().readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitDiffResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'path': z.string().readonly(),
  'patch': z.string().readonly(),
  'binary': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'gitStatus',
    params: [{ name: 'request', wire: 'request', type: 'GitStatusRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitStatusResult', schema: `z.union([${gitStatusSuccess}, ${gitFailure}])` },
  },
  {
    method: 'gitStage',
    params: [{ name: 'request', wire: 'request', type: 'GitStageRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'paths': z.array(z.string()).readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitStageResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'status': ${gitStatusSuccess}.readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'gitUnstage',
    params: [{ name: 'request', wire: 'request', type: 'GitStageRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'paths': z.array(z.string()).readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitStageResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'status': ${gitStatusSuccess}.readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'gitCommit',
    params: [{ name: 'request', wire: 'request', type: 'GitCommitRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'message': z.string().readonly(),
  'amend': z.boolean().readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitCommitResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'commit': z.string().readonly(),
  'subject': z.string().readonly(),
  'status': ${gitStatusSuccess}.readonly(),
  'notes': z.string().readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'gitPush',
    params: [{ name: 'request', wire: 'request', type: 'GitPushRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'setUpstream': z.boolean().readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitPushResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'branch': z.string().readonly(),
  'remote': z.string().readonly(),
  'published': z.boolean().readonly(),
  'status': ${gitStatusSuccess}.readonly(),
  'notes': z.string().readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'gitCommitMessage',
    params: [{ name: 'request', wire: 'request', type: 'GitCommitMessageRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'amend': z.boolean().readonly(),
})` }],
    cancellation: true,
    result: { type: 'GitCommitMessageResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'message': z.string().readonly(),
  'model': z.string().readonly(),
  'truncated': z.boolean().readonly(),
}), ${gitFailure}])` },
  },
  {
    method: 'listEntries',
    params: [{ name: 'request', wire: 'request', type: 'ListEntriesRequest', schema: `z.object({
  'path': z.string().readonly(),
  'workspacePath': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'ListEntriesResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'path': z.string().readonly(),
  'parent': z.string().readonly().optional(),
  'entries': z.array(z.object({
  'name': z.string().readonly(),
  'path': z.string().readonly(),
  'kind': ${u('file','directory','other')}.readonly(),
  'size': z.number().readonly().optional(),
})).readonly(),
  'truncated': z.boolean().readonly(),
}), ${readFileFailure}])` },
  },
  {
    method: 'openIn',
    params: [{ name: 'request', wire: 'request', type: 'OpenInRequest', schema: `z.object({
  'targetId': z.string().readonly(),
  'path': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'OpenInResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), z.object({
  'ok': z.literal(false).readonly(),
  'code': ${u('unknown-target','unavailable','launch-failed','path-denied','timeout')}.readonly(),
  'message': z.string().readonly(),
})])` },
  },
  {
    method: 'previewList',
    params: [{ name: 'request', wire: 'request', type: 'PreviewListRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'PreviewListResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'servers': z.array(${previewServerView}).readonly(),
  'launchFile': z.string().readonly().optional(),
  'launchFileError': z.string().readonly().optional(),
}), ${previewFailure}])` },
  },
  {
    method: 'previewLogs',
    params: [{ name: 'request', wire: 'request', type: 'PreviewLogsRequest', schema: `z.object({
  'serverId': z.string().readonly(),
  'fromOffset': z.number().readonly(),
})` }],
    cancellation: false,
    result: { type: 'PreviewLogsResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'serverId': z.string().readonly(),
  'text': z.string().readonly(),
  'nextOffset': z.number().readonly(),
  'lossy': z.boolean().readonly(),
  'server': ${previewServerView}.readonly(),
}), ${previewFailure}])` },
  },
  {
    method: 'previewStart',
    params: [{ name: 'request', wire: 'request', type: 'PreviewStartRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'name': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'PreviewStartResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'server': ${previewServerView}.readonly(),
}), ${previewFailure}])` },
  },
  {
    method: 'previewStop',
    params: [{ name: 'request', wire: 'request', type: 'PreviewStopRequest', schema: `z.object({
  'serverId': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'PreviewStopResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${previewFailure}])` },
  },
  {
    method: 'previewFileInfo',
    params: [{ name: 'request', wire: 'request', type: 'PreviewFileInfoRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'path': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'PreviewFileInfoResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
${previewFileInfoFields}
}), ${previewFileFailure}])` },
  },
  {
    method: 'previewPoll',
    params: [{ name: 'request', wire: 'request', type: 'PreviewPollRequest', schema: `z.object({
  'clientId': z.string().readonly(),
  'sessionId': z.string().readonly(),
  'mounted': z.boolean().readonly(),
  'bind': ${previewBind}.readonly(),
})` }],
    cancellation: false,
    result: { type: 'PreviewPollResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'message': ${previewMessage}.readonly(),
  'bindTtlMs': z.number().readonly(),
}), ${previewPollFailure}])` },
  },
  {
    method: 'previewResult',
    params: [{ name: 'request', wire: 'request', type: 'PreviewResultRequest', schema: `z.object({
  'clientId': z.string().readonly(),
  'id': z.string().readonly(),
  'ok': z.boolean().readonly(),
  'error': z.string().readonly().optional(),
  'result': ${previewCommandResult}.readonly().optional(),
  'console': z.array(${previewConsoleEntry}).readonly().optional(),
})` }],
    cancellation: false,
    result: { type: 'PreviewResultAck', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${previewPollFailure}])` },
  },
  {
    method: 'previewRelease',
    params: [{ name: 'request', wire: 'request', type: 'PreviewReleaseRequest', schema: `z.object({
  'clientId': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'PreviewReleaseResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${previewPollFailure}])` },
  },
  {
    method: 'readFile',
    params: [{ name: 'request', wire: 'request', type: 'ReadFileRequest', schema: `z.object({
  'path': z.string().readonly(),
  'workspacePath': z.string().readonly(),
})` }],
    cancellation: true,
    result: { type: 'ReadFileResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'path': z.string().readonly(),
  'text': z.string().readonly(),
  'binary': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
  'bytes': z.number().readonly(),
}), ${readFileFailure}])` },
  },
  {
    method: 'taskKill',
    params: [{ name: 'request', wire: 'request', type: 'TaskKillRequest', schema: `z.object({
  'sessionId': z.string().readonly(),
  'taskId': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'TaskKillResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'outcome': ${u('requested','already-finished')}.readonly(),
}), ${taskFailure}])` },
  },
  {
    method: 'taskOutput',
    params: [{ name: 'request', wire: 'request', type: 'TaskOutputRequest', schema: `z.object({
  'sessionId': z.string().readonly(),
  'taskId': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'TaskOutputResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'taskId': z.string().readonly(),
  'readable': z.boolean().readonly(),
  'text': z.string().readonly(),
  'reason': z.string().readonly().optional(),
}), ${taskFailure}])` },
  },
  {
    method: 'terminalClose',
    params: [{ name: 'request', wire: 'request', type: 'TerminalCloseRequest', schema: `z.object({
  'terminalId': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'TerminalAckResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${terminalFailure}])` },
  },
  {
    method: 'terminalOpen',
    params: [{ name: 'request', wire: 'request', type: 'TerminalOpenRequest', schema: `z.object({
  'workspacePath': z.string().readonly(),
  'cols': z.number().readonly(),
  'rows': z.number().readonly(),
})` }],
    cancellation: true,
    result: { type: 'TerminalOpenResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'terminalId': z.string().readonly(),
  'shell': z.string().readonly(),
  'cwd': z.string().readonly(),
  'pid': z.number().readonly(),
}), ${terminalFailure}])` },
  },
  {
    method: 'terminalRead',
    params: [{ name: 'request', wire: 'request', type: 'TerminalReadRequest', schema: `z.object({
  'terminalId': z.string().readonly(),
  'fromOffset': z.number().readonly(),
})` }],
    cancellation: false,
    result: { type: 'TerminalReadResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
  'terminalId': z.string().readonly(),
  'text': z.string().readonly(),
  'nextOffset': z.number().readonly(),
  'lossy': z.boolean().readonly(),
  'running': z.boolean().readonly(),
  'exitCode': z.union([z.number(), z.null()]).readonly().optional(),
  'signal': z.union([z.string(), z.null()]).readonly().optional(),
}), ${terminalFailure}])` },
  },
  {
    method: 'terminalSignal',
    params: [{ name: 'request', wire: 'request', type: 'TerminalSignalRequest', schema: `z.object({
  'terminalId': z.string().readonly(),
  'signal': ${u('SIGINT','SIGTERM','SIGKILL','SIGTSTP','SIGHUP')}.readonly(),
})` }],
    cancellation: false,
    result: { type: 'TerminalAckResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${terminalFailure}])` },
  },
  {
    method: 'terminalWrite',
    params: [{ name: 'request', wire: 'request', type: 'TerminalWriteRequest', schema: `z.object({
  'terminalId': z.string().readonly(),
  'data': z.string().readonly(),
})` }],
    cancellation: false,
    result: { type: 'TerminalAckResult', schema: `z.union([z.object({
  'ok': z.literal(true).readonly(),
}), ${terminalFailure}])` },
  },
]

/**
 * Line of every `@Remote(...)` decorator in `src/host/index.ts` — the line a Typert
 * `sourceLocation` points at. Read from the source rather than recorded beside each endpoint: a
 * hand-written line number goes stale without anything noticing, and a Host loader refuses an
 * artifact whose `line` is not a positive integer, which turns that staleness into a boot failure.
 */
const hostSource = await readFile(`${ROOT}${SRC}`, 'utf8')
const remoteLines = new Map(hostSource.split('\n').flatMap((text, index) => {
  const match = /@Remote\('([^']+)'\)/.exec(text)
  return match === null ? [] : [[match[1], index + 1]]
}))

/**
 * Resolve one endpoint's line in `src/host/index.ts`.
 * @param method - the endpoint's method name.
 * @returns the 1-based line of its `@Remote` decorator.
 * @throws when the Host declares no such endpoint, which means this spec has drifted from it.
 */
function sourceLine(method) {
  const line = remoteLines.get(method)
  if (line === undefined) throw new Error(`typert: no @Remote('${method}') in ${SRC} — update this spec to match the Host`)
  return line
}

const constName = (method, suffix) => `${prefix}_${NS}_${method}_${suffix}$schema`

function schemaBlock() {
  const lines = []
  for (const endpoint of ENDPOINTS) {
    endpoint.params.forEach((parameter, index) => {
      lines.push(`const ${constName(endpoint.method, `parameter_${index}`)} = ${parameter.schema}`)
    })
    lines.push(`const ${constName(endpoint.method, 'result')} = ${endpoint.result.schema}`)
  }
  return lines.join('\n')
}

function descriptorBlock() {
  return ENDPOINTS.map((endpoint) => {
    const parameters = endpoint.params.map((parameter, index) => `        {
          name: '${parameter.name}',
          wire: '${parameter.wire}',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '${TYPES}#${parameter.type}',
            schema: ${constName(endpoint.method, `parameter_${index}`)},
          },
        },`).join('\n')
    return `    {
      id: '${PKG}#${NS}/${endpoint.method}',
      service: '${SERVICE}',
      namespace: '${NS}',
      method: '${endpoint.method}',
      invocation: { kind: 'direct' },
      parameters: [
${parameters === '' ? '      ' : parameters}
      ],
${endpoint.cancellation ? "      cancellation: { parameter: 'signal' },\n" : ''}      result: {
        mode: 'strict',
        typeSymbol: '${TYPES}#${endpoint.result.type}',
        schema: ${constName(endpoint.method, 'result')},
      },
      sourceLocation: {"file":"${SRC}","line":${sourceLine(endpoint.method)},"column":3},
    },`
  }).join('\n')
}

const HEADER_REMOTE = '/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */'
const HEADER_HOST = '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */'

const remoteJs = `${HEADER_REMOTE}
import { z } from 'zod'

${schemaBlock()}

export const TYPERT_REMOTE = {
  package: '${PKG}',
  descriptors: [
${descriptorBlock()}
  ],
}

export default TYPERT_REMOTE
`

const hostJs = `${HEADER_HOST}
import { z } from 'zod'

${schemaBlock()}

export const TYPERT = {
  package: '${PKG}',
  face: 'host',
  schemas: [
  ],
  invocations: [
${descriptorBlock()}
  ],
  model: {
    "services": [],
    "events": [],
    "objects": []
  },
}
`

const signature = (endpoint) => {
  const params = endpoint.params.map(parameter => `${parameter.name}: ${parameter.type}`)
  if (endpoint.cancellation) params.push('signal?: AbortSignal')
  return `(${params.join(', ')}) => Promise<RemoteResult<${endpoint.result.type}>>`
}

const usedTypes = [...new Set(ENDPOINTS.flatMap(endpoint =>
  [...endpoint.params.map(parameter => parameter.type), endpoint.result.type]))].sort()

const hex = Buffer.from(NS, 'utf8').toString('hex')
const remoteDts = `${HEADER_REMOTE}
import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { ${usedTypes.join(', ')} } from '${TYPES}'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$${hex} {
${ENDPOINTS.map(endpoint => `    ${endpoint.method}: ${signature(endpoint)}`).join('\n')}
  }
  interface TypertRemoteMap {
${ENDPOINTS.map(endpoint => `    '${NS}/${endpoint.method}': ${signature(endpoint)}`).join('\n')}
  }
  interface TypertRemoteNamespaceMap {
    '${NS}': TypertRemoteNamespace$${hex}
  }
}

export declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
`

const hostDts = `${HEADER_HOST}

export declare const TYPERT: unknown
`

await mkdir(OUT, { recursive: true })
await writeFile(`${OUT}/typert.remote-client.js`, remoteJs)
await writeFile(`${OUT}/typert.remote-client.d.ts`, remoteDts)
await writeFile(`${OUT}/typert.host.js`, hostJs)
await writeFile(`${OUT}/typert.host.d.ts`, hostDts)
// Recorded last, and from the same inputs the check re-hashes: writing it before the artifacts
// would leave a fingerprint vouching for files a failed write never produced.
await writeFile(`${ROOT}${FINGERPRINT_FILE}`, `${await fingerprint()}\n`)
console.log(`typert: emitted ${ENDPOINTS.length} endpoints into generated/`)
