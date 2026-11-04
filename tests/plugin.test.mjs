/**
 * Plugin-level tests: tool registration, argument validation, canonical output
 * shape, path resolution, and error messages.
 *
 * The tests run against the real `@deepseek-ai/dsh-tools` registry when a
 * DeepSeek Harness installation is resolvable (see `DSH_HARNESS_ROOT`), and
 * against a recorded-contract stub otherwise, so the suite never needs network
 * access in CI.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { makeTask, startMockBackend } from './mock-backend.mjs'
import { apply, resolveBackendConfig, sessionCwd, toTaskView } from '../src/cad-translator.mjs'
import { importHarnessModule } from '../src/dsh-tools.mjs'
import { createPlugin, default as defaultPlugin } from '../src/adapter.mjs'

const EXPECTED_TOOLS = ['cad_translate', 'cad_translation_status', 'cad_download_drawing']

/** Resolve `@deepseek-ai/dsh-tools`, or explain why these tests cannot run. */
async function harnessOrSkip() {
  try {
    return { module: await importHarnessModule('@deepseek-ai/dsh-tools') }
  } catch (error) {
    if (process.env.DSH_REQUIRE_HARNESS === '1') throw error
    return {
      skip: `@deepseek-ai/dsh-tools is not installed here: ${error.message.split('\n')[0]}. `
        + 'Run from a Harness profile or export DSH_HOME.',
    }
  }
}

const harness = await harnessOrSkip()
const harnessOptions = harness.skip === undefined ? {} : { skip: harness.skip }

/** Minimal tool registry that records exactly what the plugin registers. */
function createFakeContext() {
  const registrations = []
  return {
    ctx: { tools: { register: definition => registrations.push(definition) } },
    registrations,
  }
}

/**
 * Run one tool the way the Harness executor does: validate the model
 * arguments, then call `execute` and check the canonical value against the
 * declared output schema.
 */
async function runTool(definition, args, exec = {}) {
  const { validateJsonSchemaValue } = await importHarnessModule('@deepseek-ai/dsh-tools')
  // A model omits unset optional parameters instead of sending `undefined`,
  // which is not lossless JSON; drop them before validating.
  const supplied = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  const violations = validateJsonSchemaValue(definition.parameters, supplied, '')
  assert.deepEqual(violations, [], `arguments should validate for ${definition.name}`)
  const value = await definition.execute(supplied, { signal: new AbortController().signal, ...exec })
  // `definition.output.schema` is already the compiled JSON Schema the
  // executor validates against.
  const outputViolations = validateJsonSchemaValue(definition.output.schema, value, 'value')
  assert.deepEqual(outputViolations, [], `output should validate for ${definition.name}`)
  return { value, content: definition.output.render(supplied, value) }
}

describe('plugin surface', harnessOptions, () => {
  it('registers exactly the three CAD tools on the injected tool registry', async () => {
    const { ctx, registrations } = createFakeContext()
    await apply(ctx, { backend: { baseUrl: 'http://127.0.0.1:8000' } })
    assert.deepEqual(registrations.map(entry => entry.name).sort(), [...EXPECTED_TOOLS].sort())
  })

  it('marks the tools concurrency safe and gives each a canonical JSON value', async () => {
    const { ctx, registrations } = createFakeContext()
    await apply(ctx, {})
    const sampleArgs = {
      cad_translate: { file_path: '/tmp/plan.dxf', target_language: 'en' },
      cad_translation_status: {},
      cad_download_drawing: { task_id: 'aaaa0001', artifact: 'excel' },
    }
    for (const definition of registrations) {
      assert.equal(definition.isConcurrencySafe(sampleArgs[definition.name]), true, definition.name)
      assert.ok(definition.output, definition.name)
      assert.equal(typeof definition.output.render, 'function', definition.name)
      assert.ok(definition.description.length > 30, definition.name)
    }
  })

  it('rejects an unusable configuration while loading, not on first call', async () => {
    assert.throws(() => resolveBackendConfig({ backend: { baseUrl: '' , requestTimeoutMs: -1 } }), /requestTimeoutMs/)
  })

  it('lets the environment supply the backend when the row config omits it', () => {
    const config = resolveBackendConfig({}, {
      CAD_TRANSLATION_BASE_URL: 'http://cad.internal:9000',
      CAD_TRANSLATION_ADMIN_TOKEN: 'from-env',
      CAD_TRANSLATION_TIMEOUT_MS: '5000',
      CAD_TRANSLATION_OUTPUT_DIR: '/tmp/out',
    })
    assert.deepEqual(config, {
      baseUrl: 'http://cad.internal:9000',
      adminToken: 'from-env',
      requestTimeoutMs: 5000,
      outputDir: '/tmp/out',
    })
    const explicit = resolveBackendConfig(
      { backend: { baseUrl: 'http://row:1', adminToken: 'row-token' } },
      { CAD_TRANSLATION_BASE_URL: 'http://env:2', CAD_TRANSLATION_ADMIN_TOKEN: 'env-token' },
    )
    assert.equal(explicit.baseUrl, 'http://row:1')
    assert.equal(explicit.adminToken, 'row-token')
  })

  it('names each mounted row from its configuration id', () => {
    assert.equal(createPlugin({ id: 'tool-cad-translation' }).name, 'cad-translation/tool-cad-translation')
    assert.throws(() => createPlugin({}), /non-empty `id`/)
    assert.equal(defaultPlugin.name, 'cad-translation')
    assert.deepEqual(defaultPlugin.inject, ['tools'])
  })

  it('prefers the Session working directory for relative paths', () => {
    const exec = { agent: { session: { cwd: '/srv/project' } } }
    assert.equal(sessionCwd(exec), '/srv/project')
    assert.equal(sessionCwd({ agent: { cwd: '/srv/other' } }), '/srv/other')
    assert.equal(sessionCwd({}), process.cwd())
  })

  it('projects a processing task with chunk-based progress', () => {
    const view = toTaskView(makeTask({ task_id: 'cccc0003', status: 'processing', stage: 'translating', total_chunks: 4, completed_chunks: 1 }))
    assert.equal(view.progress, 0.25)
    assert.equal(view.settled, false)
    assert.deepEqual(view.artifacts, {
      excel: '/api/cad/download/cccc0003/excel',
      translatedCad: '/api/cad/download/cccc0003/translated_cad',
    })
  })
})

describe('CAD tools end to end against the mock backend', harnessOptions, () => {
  /** @type {Awaited<ReturnType<typeof startMockBackend>>} */
  let backend
  /** @type {Record<string, any>} */
  let registrations
  let workDir

  before(async () => {
    backend = await startMockBackend({
      tasks: [
        makeTask({ task_id: 'aaaa0001', original_filename: 'plan.dxf' }),
        makeTask({ task_id: 'dddd0004', status: 'error', stage: 'failed', last_error: 'converter missing', files: {} }),
      ],
    })
    workDir = await mkdtemp(join(tmpdir(), 'dsh-cad-plugin-'))
    const collected = []
    await apply(
      { tools: { register: definition => collected.push(definition) } },
      { backend: { baseUrl: backend.baseUrl, outputDir: workDir } },
    )
    registrations = Object.fromEntries(collected.map(definition => [definition.name, definition]))
  })

  after(async () => {
    await backend.close()
    await rm(workDir, { recursive: true, force: true })
  })

  it('queues a translation and reports the task id and file name', async () => {
    const filePath = join(workDir, 'plan.dxf')
    await writeFile(filePath, '0\nSECTION\nEOF\n')
    const { value, content } = await runTool(registrations.cad_translate, {
      file_path: filePath,
      target_language: 'en',
    })
    assert.equal(value.taskId, '0badf00d')
    assert.equal(value.fileName, 'plan.dxf')
    assert.equal(value.status, 'queued')
    assert.equal(value.extractOnly, false)
    assert.match(value.message, /cad_translation_status/)
    assert.deepEqual(content, [{ type: 'text', text: value.message }])
  })

  it('resolves a relative drawing path against the Session working directory', async () => {
    await writeFile(join(workDir, 'relative.dxf'), '0\nSECTION\nEOF\n')
    const { value } = await runTool(
      registrations.cad_translate,
      { file_path: 'relative.dxf', target_language: 'zh' },
      { agent: { session: { cwd: workDir } } },
    )
    assert.equal(value.fileName, 'relative.dxf')
    assert.equal(value.targetLanguage, 'zh')
  })

  it('reports a missing drawing as an actionable error', async () => {
    const missingPath = join(workDir, 'absent.dxf')
    // Assert the message, not just a keyword: a bare runtime string such as
    // "TypeError: Unable to open file as blob" tells the caller nothing.
    await assert.rejects(
      runTool(registrations.cad_translate, { file_path: missingPath, target_language: 'en' }),
      (error) => {
        assert.match(error.message, /Cannot upload/)
        assert.ok(error.message.includes(missingPath), 'the rejected path must be named')
        assert.match(error.message, /no such file/)
        return true
      },
    )
  })

  it('rejects a directory instead of letting the upload fail later', async () => {
    await assert.rejects(
      runTool(registrations.cad_translate, { file_path: workDir, target_language: 'en' }),
      /not a regular file/,
    )
  })

  it('reads one task, including its log tail on request', async () => {
    const plain = await runTool(registrations.cad_translation_status, { task_id: 'aaaa0001' })
    assert.equal(plain.value.tasks.length, 1)
    assert.equal(plain.value.tasks[0].settled, true)
    assert.match(plain.value.message, /status=done/)
    assert.equal(plain.value.log, undefined)

    const withLog = await runTool(registrations.cad_translation_status, { task_id: 'aaaa0001', include_log: true })
    assert.match(withLog.value.log, /translated 12 texts/)
    assert.match(withLog.content[0].text, /line one/)
  })

  it('lists recent tasks when no id is given', async () => {
    const { value } = await runTool(registrations.cad_translation_status, {})
    assert.equal(value.tasks.length, 2)
    assert.match(value.message, /2 of 2 CAD task/)
  })

  it('downloads the translated drawing into the configured directory', async () => {
    const { value, content } = await runTool(registrations.cad_download_drawing, {
      task_id: 'aaaa0001',
      artifact: 'translated_cad',
    })
    assert.equal(value.fileName, 'drawing-translated.dxf')
    assert.equal(value.path, join(workDir, 'drawing-translated.dxf'))
    assert.ok(value.bytes > 0)
    assert.match(content[0].text, /Saved translated_cad of task aaaa0001/)
  })

  it('refuses to download from a task that failed', async () => {
    await assert.rejects(
      runTool(registrations.cad_download_drawing, { task_id: 'dddd0004', artifact: 'translated_cad' }),
      /task dddd0004 is error: converter missing/,
    )
  })

  it('refuses an artifact the task has not produced yet', async () => {
    backend.tasks.set('eeee0005', makeTask({ task_id: 'eeee0005', status: 'processing', stage: 'translating', files: {} }))
    await assert.rejects(
      runTool(registrations.cad_download_drawing, { task_id: 'eeee0005', artifact: 'translated_cad' }),
      /has no translated_cad artifact yet \(status processing, stage translating\)/,
    )
  })

  it('explains a rejected task id instead of building a download path', async () => {
    await assert.rejects(
      runTool(registrations.cad_download_drawing, { task_id: '../escape', artifact: 'excel' }),
      /taskId must be the 8-character hex id/,
    )
  })
})

describe('tool output token redaction', harnessOptions, () => {
  it('redacts both rotated tokens when a token matches the usual marker', async () => {
    const original = process.env.CAD_TRANSLATION_ADMIN_TOKEN
    const first = 'REDACTED'
    const next = '[REDACTED]'
    process.env.CAD_TRANSLATION_ADMIN_TOKEN = first
    const server = createServer((req, res) => {
      process.env.CAD_TRANSLATION_ADMIN_TOKEN = next
      res.end(JSON.stringify({ data: [makeTask({ original_filename: `${first} ${next}.dxf` })], total: 1 }))
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    try {
      const collected = []
      await apply({ tools: { register: item => collected.push(item) } }, {
        backend: { baseUrl: `http://127.0.0.1:${server.address().port}` },
      })
      const status = collected.find(item => item.name === 'cad_translation_status')
      const result = await runTool(status, {})
      const rendered = JSON.stringify(result)
      assert.equal(rendered.includes(first), false)
      assert.equal(rendered.includes(next), false)
    } finally {
      if (original === undefined) delete process.env.CAD_TRANSLATION_ADMIN_TOKEN
      else process.env.CAD_TRANSLATION_ADMIN_TOKEN = original
      await new Promise(done => server.close(done))
    }
  })

  it('redacts nested status, logs, saved names and errors without changing the real paths', async () => {
    const token = 'test-secret-token'
    const task = makeTask({ task_id: 'aaaa0001', original_filename: `${token}.dxf`, last_error: `log ${token}`,
      files: { excel_file: `/data/${token}.xlsx` } })
    const server = createServer((req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path.endsWith('/logs')) return res.end(JSON.stringify({ data: { logs: `start ${token} end` } }))
      if (path.endsWith('/download/aaaa0001/excel')) {
        res.setHeader('content-disposition', `attachment; filename="${token}.xlsx"`)
        return res.end('artifact')
      }
      const data = path === '/api/cad/tasks' ? [task] : task
      res.end(JSON.stringify({ data, total: 1 }))
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const workDir = await mkdtemp(join(tmpdir(), 'dsh-cad-redaction-'))
    try {
      const collected = []
      await apply({ tools: { register: item => collected.push(item) } }, {
        backend: { baseUrl: `http://127.0.0.1:${server.address().port}`, outputDir: workDir, adminToken: token },
      })
      const tools = Object.fromEntries(collected.map(item => [item.name, item]))
      for (const args of [{}, { task_id: 'aaaa0001', include_log: true }]) {
        const result = await runTool(tools.cad_translation_status, args)
        assert.equal(JSON.stringify(result).includes(token), false)
        assert.match(JSON.stringify(result), /\[REDACTED\]/)
      }
      const result = await runTool(tools.cad_download_drawing, { task_id: 'aaaa0001', artifact: 'excel' })
      assert.equal(JSON.stringify(result).includes(token), false)
      assert.match(result.value.fileName, /\[REDACTED\]/)
      // Redaction must not change the actual file written to disk.
      assert.equal(await readFile(join(workDir, `${token}.xlsx`), 'utf8'), 'artifact')
      const coincident = []
      await apply({ tools: { register: item => coincident.push(item) } }, {
        backend: { baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'aaaa0001' },
      })
      const statusTool = coincident.find(item => item.name === 'cad_translation_status')
      const status = await runTool(statusTool, { task_id: 'aaaa0001', include_log: true })
      assert.equal(status.value.tasks[0].taskId, '[REDACTED]')
      assert.match(status.value.log, /start/)
      task.status = 'error'
      await assert.rejects(runTool(tools.cad_download_drawing, { task_id: 'aaaa0001', artifact: 'excel' }), error => {
        assert.equal(error.message.includes(token), false)
        assert.match(error.message, /\[REDACTED\]/)
        return true
      })
      await assert.rejects(runTool(tools.cad_translate, { file_path: join(workDir, `${token}-missing.dxf`), target_language: 'en' }), error => {
        assert.equal(error.message.includes(token), false)
        assert.match(error.message, /\[REDACTED\]/)
        return true
      })
    } finally {
      await new Promise(done => server.close(done))
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
