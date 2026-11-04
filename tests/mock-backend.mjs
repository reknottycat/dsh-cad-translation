/**
 * Minimal stand-in for the CAD translation backend.
 *
 * It reproduces only the contract the plugin depends on: the queued upload
 * response, the task summary shape, the log route and the artifact download
 * routes, including the admin-token guard. Using it keeps the integration
 * tests offline and independent of CAD software, an LLM key, or a translation
 * run, which the real pipeline needs.
 */

import { createServer } from 'node:http'

/** One in-memory task, seeded or created through the upload route. */
function makeTask(overrides = {}) {
  const taskId = overrides.task_id ?? 'deadbeef'
  return {
    task_id: taskId,
    original_filename: 'drawing.dxf',
    target_language: 'en',
    extract_only: false,
    status: 'done',
    stage: 'completed',
    text_count: 12,
    translation_count: 10,
    translated_count: 10,
    failed_count: 0,
    total_chunks: 2,
    completed_chunks: 2,
    last_error: '',
    files: {
      excel_file: `/api/cad/download/${taskId}/excel`,
      translated_cad_file: `/api/cad/download/${taskId}/translated_cad`,
    },
    ...overrides,
  }
}

/**
 * Start the mock backend.
 * @param {object} [options]
 * @param {Array<object>} [options.tasks] Seed task summaries.
 * @param {string} [options.adminToken] Required `X-Admin-Token`; empty disables the guard.
 * @param {Registry} [options.registry] Shared state, so a test can mutate tasks.
 */
export async function startMockBackend(options = {}) {
  const state = options.registry ?? new Map()
  for (const task of options.tasks ?? []) state.set(task.task_id, task)
  const adminToken = options.adminToken ?? ''
  const uploads = []
  const requested = []

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requested.push({ method: request.method, path: url.pathname })
    const send = (status, body, headers = {}) => {
      const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
      response.writeHead(status, { 'content-type': 'application/json', ...headers })
      response.end(payload)
    }
    if (adminToken && request.headers['x-admin-token'] !== adminToken) {
      return send(401, { detail: 'admin token required' })
    }

    if (request.method === 'POST' && url.pathname === '/api/cad/upload') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('latin1')
      uploads.push({ contentType: request.headers['content-type'] ?? '', body })
      return send(200, { success: true, data: { task_id: '0badf00d', status: 'queued', stage: 'queued' } })
    }

    if (request.method === 'GET' && url.pathname === '/api/cad/tasks') {
      const tasks = [...state.values()]
      return send(200, { success: true, data: tasks, total: tasks.length })
    }

    const logMatch = /^\/api\/cad\/tasks\/([0-9a-f]+)\/logs$/.exec(url.pathname)
    if (request.method === 'GET' && logMatch) {
      if (!state.has(logMatch[1])) return send(404, { detail: 'task not found' })
      return send(200, { success: true, data: { logs: 'line one\nline two\ntranslated 12 texts' } })
    }

    const taskMatch = /^\/api\/cad\/tasks\/([0-9a-f]+)$/.exec(url.pathname)
    if (request.method === 'GET' && taskMatch) {
      const task = state.get(taskMatch[1])
      if (!task) return send(404, { detail: `task ${taskMatch[1]} not found` })
      return send(200, { success: true, data: task })
    }

    const downloadMatch = /^\/api\/cad\/download\/([0-9a-f]+)\/(excel|translated_cad)$/.exec(url.pathname)
    if (request.method === 'GET' && downloadMatch) {
      const [, taskId, artifact] = downloadMatch
      const task = state.get(taskId)
      if (!task) return send(404, { detail: `task ${taskId} not found` })
      const available = artifact === 'excel' ? task.files?.excel_file : task.files?.translated_cad_file
      if (!available) return send(404, { detail: `${artifact} is not available for task ${taskId}` })
      const name = artifact === 'excel' ? 'drawing-text.xlsx' : 'drawing-translated.dxf'
      return send(
        200,
        `artifact:${taskId}:${artifact}`,
        { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` },
      )
    }

    if (request.method === 'GET' && url.pathname === '/api/translation/languages') {
      return send(200, { languages: { en: 'English', zh: '中文' }, default_source: 'auto', default_target: 'en' })
    }

    return send(404, { detail: `no route for ${request.method} ${url.pathname}` })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tasks: state,
    uploads,
    requested,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

export { makeTask }
