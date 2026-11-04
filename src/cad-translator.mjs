/**
 * DeepSeek Harness tool plugin that exposes the CAD translation backend.
 *
 * The plugin is a thin consumer: a model turn calls one of these tools and the
 * backend keeps doing conversion, extraction, LLM translation and back-fill on
 * its own async task queue. Nothing here re-implements that pipeline.
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { CadTranslationClient, redactText } from '../client.mjs'
import { importHarnessModule } from './dsh-tools.mjs'

/** Stable Cordis plugin identity. */
export const name = 'cad-translation'

/** The tool registry is the only service this plugin needs. */
export const inject = ['tools']

/** Default backend origin of the CAD translation web app. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'

/** Statuses the backend reports for a settled task. */
const TERMINAL_STATUSES = new Set(['done', 'partial', 'error', 'cancelled'])

/**
 * Settings of the whole plugin row. Keeping one nested object means a user
 * patch that overrides a single field cannot silently drop the others.
 *
 * @typedef {object} Config
 * @property {Partial<BackendConfig>} [backend] Where the CAD translation backend runs.
 */

/**
 * @typedef {object} BackendConfig
 * @property {string} baseUrl Backend origin.
 * @property {string} adminToken Value for `X-Admin-Token`; empty when the guard is off.
 * @property {number} requestTimeoutMs Deadline per HTTP request.
 * @property {string} outputDir Directory for downloaded artifacts, relative paths use the Session working directory.
 */

/**
 * Read the backend settings, preferring plugin config and falling back to
 * `CAD_TRANSLATION_*` environment variables so a profile patch never has to
 * carry a secret, and so one backend can serve several sessions.
 * @param {Config} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BackendConfig}
 */
export function resolveBackendConfig(config = {}, env = process.env) {
  const source = config?.backend ?? {}
  const fromEnv = Number(env.CAD_TRANSLATION_TIMEOUT_MS || 0)
  const requestTimeoutMs = source.requestTimeoutMs ?? (fromEnv || 120_000)
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`backend.requestTimeoutMs must be a positive number of milliseconds (got ${requestTimeoutMs})`)
  }
  return {
    baseUrl: source.baseUrl || env.CAD_TRANSLATION_BASE_URL || DEFAULT_BASE_URL,
    adminToken: source.adminToken || env.CAD_TRANSLATION_ADMIN_TOKEN || '',
    requestTimeoutMs,
    outputDir: source.outputDir || env.CAD_TRANSLATION_OUTPUT_DIR || '.cad-translation',
  }
}

/**
 * Cordis plugin identity derived from a row `id`, so each mounted row logs and
 * re-registers as its own plugin instead of sharing the package-level name.
 * @param {string} id
 * @returns {string}
 */
export function namespacedName(id) {
  const rowId = typeof id === 'string' ? id.trim() : ''
  if (!rowId) {
    throw new Error('the CAD translation plugin row needs a non-empty `id` in its Cordis configuration')
  }
  return `${name}/${rowId}`
}

/**
 * Resolve the Session working directory a relative path is based on.
 * @param {unknown} exec
 * @returns {string}
 */
export function sessionCwd(exec) {
  const candidates = [exec?.agent?.session?.cwd, exec?.agent?.cwd, process.cwd()]
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value
  }
  return process.cwd()
}

/**
 * Pre-flight check used by `cad_translate`, so a bad path fails with the path
 * spelled out instead of a stripped-down runtime error.
 * @param {string} filePath Absolute path the tool is about to upload.
 * @returns {Promise<Error | null>} The error to throw, or null when the file is usable.
 */
async function requireDrawing(filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    const reason = error?.code === 'EACCES' || error?.code === 'EPERM'
      ? 'permission denied'
      : error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        ? 'no such file'
        : String(error?.message ?? error)
    return new Error(`Cannot upload ${filePath}: ${reason}. Pass an absolute path or one relative to the Session working directory.`)
  }
  if (!info.isFile()) {
    return new Error(`Cannot upload ${filePath}: not a regular file. Point file_path at a single .dxf or .dwg drawing.`)
  }
  return null
}

/**
 * Turn one backend failure into an actionable message without leaking the token.
 * @param {unknown} error
 * @param {Config} config
 * @returns {never}
 */
function rethrow(error) {
  if (error?.name === 'CadFileError') {
    throw new Error(`${error.message}. Pass an absolute path or one relative to the Session working directory.`)
  }
  if (error?.name === 'CadConnectionError') {
    throw new Error(
      `${error.message}. Start the CAD translation backend (backend/run_server.py or `
      + 'start_delivery.bat) and check plugin config baseUrl.',
    )
  }
  if (error?.name === 'CadHttpError') {
    const hint = error.status === 401 || error.status === 403
      ? ' The backend admin guard rejected the request: set CAD_TRANSLATION_ADMIN_TOKEN.'
      : error.status === 503
        ? ' The backend has ENABLE_ADMIN_GUARD=true but no ADMIN_API_TOKEN, so it refuses protected routes.'
        : ''
    throw new Error(`${error.message}.${hint}`)
  }
  throw error
}

// Redact at the tool boundary only; backend IDs and paths stay intact while
// the operation runs. Both canonical values and rendered messages are covered.
function redactValue(value, tokens) {
  if (typeof value === 'string') {
    return redactText(value, tokens)
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, tokens))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, tokens)]))
  }
  return value
}

/**
 * Register the three CAD tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} [rawConfig]
 */
export async function apply(ctx, rawConfig = {}) {
  // Validate eagerly so a broken row fails while loading, then hand the client
  // a getter: the token usually arrives through the environment, which a long
  // running Host may hold before the operator exports it.
  resolveBackendConfig(rawConfig)
  const backend = () => resolveBackendConfig(rawConfig)
  const client = {
    get baseUrl() { return backend().baseUrl },
    get adminToken() { return backend().adminToken },
    get requestTimeoutMs() { return backend().requestTimeoutMs },
    submitTranslation: input => new CadTranslationClient(backend()).submitTranslation(input),
    getTask: (taskId, signal) => new CadTranslationClient(backend()).getTask(taskId, signal),
    listTasks: options => new CadTranslationClient(backend()).listTasks(options),
    downloadArtifact: input => new CadTranslationClient(backend()).downloadArtifact(input),
    request: (path, init) => new CadTranslationClient(backend()).request(path, init),
  }
  const { defineTool } = await importHarnessModule('@deepseek-ai/dsh-tools')
  const registerTool = definition => {
    const execute = definition.execute
    ctx.tools.register(defineTool({
      ...definition,
      async execute(args, exec) {
        const initialToken = String(backend().adminToken ?? '').trim()
        try {
          const value = await execute(args, exec)
          const safe = redactValue(value, [...new Set([initialToken, String(backend().adminToken ?? '').trim()])])
          // Truncate only after redaction to avoid exposing part of a token.
          if (typeof safe?.log === 'string') safe.log = tail(safe.log, 4000)
          return safe
        } catch (error) {
          const tokens = [...new Set([initialToken, String(backend().adminToken ?? '').trim()])]
          const message = redactValue(String(error?.message ?? error), tokens)
          const safe = new Error(message)
          safe.name = redactValue(String(error?.name || 'Error'), tokens)
          if (typeof error?.code === 'string') safe.code = redactValue(error.code, tokens)
          throw safe
        }
      },
    }))
  }

  registerTool({
    name: 'cad_translate',
    description: 'Translate the text of a DXF/DWG drawing into another language and return a task id. '
      + 'The backend converts, extracts, translates and writes the text back asynchronously; '
      + 'call cad_translation_status to follow it and cad_download_drawing to fetch the result. '
      + 'Uploads the file at the given local path to the configured CAD translation backend.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path of an existing .dxf or .dwg file. Relative paths resolve against the Session working directory.',
      },
      target_language: {
        type: 'string',
        required: true,
        description: 'Target language code, for example "en", "zh", "ja".',
      },
      extract_only: {
        type: 'boolean',
        description: 'Only extract the drawing text into Excel and skip translation (default false).',
      },
      converter_backend: {
        type: 'string',
        enum: ['auto', 'dxf_only', 'autocad', 'haochen', 'oda', 'libredwg'],
        description: 'DWG converter to use; "auto" tries the backends the backend host supports (default auto).',
      },
      translation_mode: {
        type: 'string',
        enum: ['replace', 'add'],
        description: 'replace swaps each original text, add writes the translation below it (default replace).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          fileName: { type: 'string', required: true },
          targetLanguage: { type: 'string', required: true },
          status: { type: 'string', required: true },
          extractOnly: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = isAbsolute(args.file_path)
        ? args.file_path
        : resolve(sessionCwd(exec), args.file_path)
      // Resolve before uploading: a relative path is meaningless to the backend,
      // and the caller needs to see the absolute path that was actually tried.
      const missing = await requireDrawing(filePath)
      if (missing) throw missing
      try {
        const { taskId, fileName } = await client.submitTranslation({
          filePath,
          targetLanguage: args.target_language,
          converterBackend: args.converter_backend,
          translationMode: args.translation_mode,
          extractOnly: args.extract_only === true,
          signal: exec.signal,
        })
        return {
          taskId,
          fileName,
          targetLanguage: args.target_language,
          status: 'queued',
          extractOnly: args.extract_only === true,
          message: `Queued CAD task ${taskId} for ${fileName} (target language ${args.target_language}). `
            + 'Poll it with cad_translation_status; large drawings take minutes.',
        }
      } catch (error) {
        throw rethrow(error)
      }
    },
  })

  registerTool({
    name: 'cad_translation_status',
    description: 'Read the progress of one CAD translation task, or list the recent tasks when task_id is omitted. '
      + 'A task is settled when status is done, partial, error or cancelled.',
    parameters: {
      task_id: { type: 'string', description: 'Task id returned by cad_translate.' },
      limit: { type: 'integer', description: 'How many recent tasks to list when task_id is omitted (default 20).' },
      include_log: { type: 'boolean', description: 'Append the tail of the backend task log (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                originalFileName: { type: 'string', required: true },
                status: { type: 'string', required: true },
                stage: { type: 'string', required: true },
                settled: { type: 'boolean', required: true },
                targetLanguage: { type: 'string', required: true },
                textCount: { type: 'integer', required: true },
                translatedCount: { type: 'integer', required: true },
                failedCount: { type: 'integer', required: true },
                progress: { type: 'number', required: true },
                lastError: { type: 'string', required: true },
                artifacts: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    excel: { type: 'string' },
                    translatedCad: { type: 'string' },
                  },
                },
              },
            },
          },
          log: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.log ? `${value.message}\n\n${value.log}` : value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (args.task_id === undefined || String(args.task_id).trim() === '') {
          const { tasks, total } = await client.listTasks({ limit: args.limit ?? 20, signal: exec.signal })
          if (!tasks.length) {
            return { tasks: [], message: 'No CAD translation tasks exist on this backend yet.' }
          }
          return {
            tasks: tasks.map(toTaskView),
            message: `${tasks.length} of ${total} CAD task(s):\n${tasks.map(describeTask).join('\n')}`,
          }
        }
        const summary = await client.getTask(args.task_id, exec.signal)
        const task = toTaskView(summary)
        if (args.include_log !== true) return { tasks: [task], message: describeTask(summary) }
        const logs = await client.request(`/api/cad/tasks/${task.taskId}/logs`, { signal: exec.signal })
        return { tasks: [task], log: String(logs?.data?.logs ?? ''), message: describeTask(summary) }
      } catch (error) {
        throw rethrow(error)
      }
    },
  })

  registerTool({
    name: 'cad_download_drawing',
    description: 'Download a finished artifact of one CAD translation task to a local directory: '
      + 'the back-filled drawing (translated_cad) or the extracted/translated text workbook (excel).',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by cad_translate.' },
      artifact: {
        type: 'string',
        required: true,
        enum: ['translated_cad', 'excel'],
        description: 'translated_cad for the drawing, excel for the text workbook.',
      },
      output_dir: {
        type: 'string',
        description: 'Directory that receives the file. Relative paths resolve against the Session working directory.',
      },
      file_name: { type: 'string', description: 'Optional file name to use instead of the backend-provided one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          artifact: { type: 'string', required: true },
          path: { type: 'string', required: true },
          fileName: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const taskId = String(args.task_id ?? '').trim()
      try {
        // Refuse to hand back an artifact the backend has not produced yet.
        const summary = await client.getTask(taskId, exec.signal)
        const view = toTaskView(summary)
        if (view.status === 'cancelled' || view.status === 'error') {
          throw new Error(`task ${taskId} is ${view.status}: ${view.lastError || 'no detail reported'}`)
        }
        const task = args.artifact === 'excel'
          ? summary?.files?.excel_file
          : summary?.files?.translated_cad_file
        if (!task) {
          throw new Error(
            `task ${taskId} has no ${args.artifact} artifact yet (status ${view.status}, stage ${view.stage}). `
            + 'Poll cad_translation_status until it settles.',
          )
        }
        const outputDir = args.output_dir
          ? (isAbsolute(args.output_dir) ? args.output_dir : resolve(sessionCwd(exec), args.output_dir))
          : resolve(sessionCwd(exec), backend().outputDir)
        const file = await client.downloadArtifact({
          taskId,
          artifact: args.artifact,
          outputDir,
          fileName: args.file_name,
          signal: exec.signal,
        })
        const { size } = await stat(file.path)
        return {
          taskId,
          artifact: args.artifact,
          path: file.path,
          fileName: file.fileName,
          bytes: size,
          message: `Saved ${args.artifact} of task ${taskId} to ${file.path} (${size} bytes).`,
        }
      } catch (error) {
        throw rethrow(error)
      }
    },
  })
}

/**
 * Project one backend task summary into the canonical tool value.
 * @param {any} summary
 */
export function toTaskView(summary) {
  const status = String(summary?.status ?? 'unknown')
  const textCount = Number(summary?.text_count ?? 0)
  const translatedCount = Number(summary?.translated_count ?? summary?.translation_count ?? 0)
  const totalChunks = Number(summary?.total_chunks ?? 0)
  const completedChunks = Number(summary?.completed_chunks ?? 0)
  const progress = totalChunks > 0
    ? Math.min(completedChunks / totalChunks, 1)
    : (textCount > 0 ? Math.min(translatedCount / textCount, 1) : 0)
  const view = {
    taskId: String(summary?.task_id ?? ''),
    originalFileName: String(summary?.original_filename ?? ''),
    status,
    stage: String(summary?.stage ?? ''),
    settled: TERMINAL_STATUSES.has(status),
    targetLanguage: String(summary?.target_language ?? ''),
    textCount,
    translatedCount,
    failedCount: Number(summary?.failed_count ?? 0),
    progress: Math.round(progress * 1000) / 1000,
    lastError: String(summary?.last_error ?? ''),
    artifacts: {},
  }
  if (summary?.files?.excel_file) view.artifacts.excel = String(summary.files.excel_file)
  if (summary?.files?.translated_cad_file) view.artifacts.translatedCad = String(summary.files.translated_cad_file)
  return view
}

/**
 * One human-readable line for a task summary.
 * @param {any} summary
 */
export function describeTask(summary) {
  const view = toTaskView(summary)
  const parts = [
    `task ${view.taskId} (${view.originalFileName})`,
    `status=${view.status}`,
    `stage=${view.stage}`,
    `progress=${Math.round(view.progress * 100)}%`,
    `texts=${view.textCount}`,
    `translated=${view.translatedCount}`,
  ]
  if (view.failedCount > 0) parts.push(`failed=${view.failedCount}`)
  if (view.lastError) parts.push(`error=${view.lastError}`)
  if (view.artifacts.translatedCad) parts.push('translated drawing ready')
  return parts.join(' · ')
}

/**
 * Keep only the last `max` characters of a log.
 * @param {string} text
 * @param {number} max
 */
export function tail(text, max) {
  return text.length <= max ? text : `…\n${text.slice(text.length - max)}`
}
