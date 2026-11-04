/**
 * Dependency-free HTTP client for the CAD Translation backend.
 *
 * Only the documented JSON/upload endpoints behind `/api/cad` are used, so the
 * plugin never restates translation, conversion, or backfill logic the backend
 * already owns.
 */

import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Backend answered with a non-2xx status. */
export class CadHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, detail: string, path: string }} info
   */
  constructor(message, info) {
    super(message)
    this.name = 'CadHttpError'
    Object.assign(this, info)
  }
}

/** The backend could not be reached at all. */
export class CadConnectionError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.name = 'CadConnectionError'
  }
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}$/

/**
 * Accept only the system-generated 8-hex task id shape, mirroring the backend
 * guard, so a mistyped value never becomes part of a download path.
 * @param {string} value
 * @returns {string}
 */
export function normalizeTaskId(value) {
  const taskId = String(value ?? '').trim()
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`taskId must be the 8-character hex id returned by cad_translate (got ${JSON.stringify(value)})`)
  }
  return taskId
}

/**
 * Normalize a configured backend URL and reject values fetch cannot use.
 * @param {string} value
 * @returns {string}
 */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('baseUrl is required')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`baseUrl must use http or https (got ${JSON.stringify(url.protocol)})`)
  }
  return url.toString().replace(/\/+$/, '')
}

/** @param {string} value */
function adminHeaders(value) {
  const token = String(value ?? '').trim()
  return token ? { 'X-Admin-Token': token } : {}
}

/** The file to upload is missing, unreadable, or not a regular file. */
export class CadFileError extends Error {
  /**
   * @param {string} message
   * @param {{ path: string, cause?: unknown }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.name = 'CadFileError'
    Object.assign(this, info)
  }
}

/**
 * Check the drawing before it reaches `FormData`.
 *
 * `openAsBlob` runs as a microtask, so on a slow Node its ENOENT failure can be
 * reported as a bare `TypeError: Unable to open file as blob` with no path and
 * no errno — which is exactly what a caller cannot act on. Owning the check
 * keeps the message stable across Node versions.
 * @param {string} filePath
 */
async function assertReadableFile(filePath) {
  if (!filePath.trim()) throw new CadFileError('drawing path is empty', { path: filePath })
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new CadFileError(`no such file: ${filePath}`, { path: filePath, cause: error })
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new CadFileError(`cannot read ${filePath}: permission denied`, { path: filePath, cause: error })
    }
    throw new CadFileError(`cannot read ${filePath}: ${error?.message ?? error}`, { path: filePath, cause: error })
  }
  if (!info.isFile()) throw new CadFileError(`not a regular file: ${filePath}`, { path: filePath })
}

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl Backend origin, e.g. `http://127.0.0.1:8000`.
 * @property {string} [adminToken] Value for `X-Admin-Token` when the backend runs with its admin guard.
 * @property {number} [requestTimeoutMs] Per-request deadline.
 * @property {typeof fetch} [fetch] Injection point for tests and custom transports.
 */

/**
 * Thin wrapper over the backend's CAD task endpoints.
 */
export class CadTranslationClient {
  /** @param {ClientOptions} options */
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.adminToken = options.adminToken ?? ''
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.fetch = options.fetch ?? globalThis.fetch
    if (typeof this.fetch !== 'function') {
      throw new Error('this runtime has no fetch; pass options.fetch')
    }
  }

  /**
   * Send one request and unwrap `{ success, data }` or the `{ languages }` shape.
   * @param {string} path
   * @param {RequestInit & { signal?: AbortSignal, timeoutMs?: number }} [init]
   * @returns {Promise<any>}
   */
  async request(path, init = {}) {
    const { signal, timeoutMs, headers, ...rest } = init
    const timeout = AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const url = `${this.baseUrl}${path}`
    let response
    try {
      response = await this.fetch(url, {
        ...rest,
        signal: combined,
        headers: { ...adminHeaders(this.adminToken), ...headers },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) {
        throw new CadConnectionError(`backend did not answer ${path} within ${timeoutMs ?? this.requestTimeoutMs} ms`)
      }
      throw new CadConnectionError(`cannot reach the CAD translation backend at ${this.baseUrl}`, { cause: error })
    }
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new CadHttpError(`backend returned non-JSON output for ${path}`, {
        status: response.status, detail: text.slice(0, 500), path,
      })
    }
    if (!response.ok) {
      const detail = typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload)
      throw new CadHttpError(`backend rejected ${path} (HTTP ${response.status}): ${detail}`, {
        status: response.status, detail, path,
      })
    }
    return payload
  }

  /**
   * Queue one DXF/DWG conversion+translation task and wait for its id.
   * @param {object} input
   * @param {string} input.filePath Absolute path of an existing .dxf/.dwg file.
   * @param {string} input.targetLanguage Target language code.
   * @param {string} [input.converterBackend]
   * @param {string} [input.translationMode]
   * @param {boolean} [input.extractOnly]
   * @param {AbortSignal} [input.signal]
   */
  async submitTranslation(input) {
    const filePath = String(input.filePath ?? '')
    await assertReadableFile(filePath)
    const form = new FormData()
    const fileName = basename(filePath)
    form.set('file', await openAsBlob(filePath), fileName)
    form.set('target_language', input.targetLanguage)
    form.set('converter_backend', input.converterBackend ?? 'auto')
    form.set('translation_mode', input.translationMode ?? 'replace')
    form.set('extract_only', input.extractOnly ? 'true' : 'false')
    form.set('background', 'true')
    const payload = await this.request('/api/cad/upload', {
      method: 'POST',
      body: form,
      signal: input.signal,
    })
    return { taskId: normalizeTaskId(payload?.data?.task_id), fileName }
  }

  /**
   * Read one task summary.
   * @param {string} taskId
   * @param {AbortSignal} [signal]
   */
  async getTask(taskId, signal) {
    const id = normalizeTaskId(taskId)
    const payload = await this.request(`/api/cad/tasks/${id}`, { signal })
    return payload.data
  }

  /**
   * List task summaries, newest activity first.
   * @param {{ limit?: number, offset?: number, signal?: AbortSignal }} [options]
   */
  async listTasks(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit ?? 20) || 20, 1), 1000)
    const offset = Math.max(Number(options.offset ?? 0) || 0, 0)
    const payload = await this.request(`/api/cad/tasks?limit=${limit}&offset=${offset}`, { signal: options.signal })
    return { tasks: Array.isArray(payload.data) ? payload.data : [], total: payload.total ?? 0 }
  }

  /**
   * Download one finished artifact into a directory.
   *
   * `excel` returns the extracted/translated text workbook, `translated_cad`
   * the back-filled drawing.
   * @param {object} input
   * @param {string} input.taskId
   * @param {'excel'|'translated_cad'} input.artifact
   * @param {string} input.outputDir Directory that receives the file.
   * @param {string} [input.fileName] Override for the backend-provided name.
   * @param {AbortSignal} [input.signal]
   */
  async downloadArtifact(input) {
    const taskId = normalizeTaskId(input.taskId)
    if (input.artifact !== 'excel' && input.artifact !== 'translated_cad') {
      throw new Error(`artifact must be "excel" or "translated_cad" (got ${JSON.stringify(input.artifact)})`)
    }
    const path = `/api/cad/download/${taskId}/${input.artifact}`
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        signal,
        headers: adminHeaders(this.adminToken),
      })
    } catch (error) {
      if (input.signal?.aborted) throw error
      throw new CadConnectionError(`cannot reach the CAD translation backend at ${this.baseUrl}`, { cause: error })
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new CadHttpError(`backend rejected ${path} (HTTP ${response.status}): ${detail.slice(0, 500)}`, {
        status: response.status, detail, path,
      })
    }
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(input.outputDir, { recursive: true })
    const name = input.fileName || fileNameFromDisposition(response.headers.get('content-disposition'))
      || `${taskId}-${input.artifact === 'excel' ? 'text.xlsx' : 'translated.dxf'}`
    const target = join(input.outputDir, name)
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    return { path: target, fileName: name }
  }

  /** Supported target languages plus the backend defaults. */
  async getLanguages(signal) {
    return this.request('/api/translation/languages', { signal })
  }
}

/**
 * Read `filename*=UTF-8''…`/`filename="…"` from a Content-Disposition header.
 * @param {string | null} header
 * @returns {string | undefined}
 */
export function fileNameFromDisposition(header) {
  if (!header) return undefined
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() || undefined
}
