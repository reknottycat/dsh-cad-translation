/** Transport-level tests for the backend client, against the mock backend. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  CadHttpError,
  CadTranslationClient,
  fileNameFromDisposition,
  normalizeBaseUrl,
  normalizeTaskId,
} from '../client.mjs'
import { makeTask, startMockBackend } from './mock-backend.mjs'

describe('client helpers', () => {
  it('accepts only the system-generated 8-hex task id', () => {
    assert.equal(normalizeTaskId(' 0badf00d '), '0badf00d')
    for (const bad of ['', '../etc', '0BADF00D', 'abc', 'zzzzzzzz', null, 42]) {
      assert.throws(() => normalizeTaskId(bad), /taskId must be/)
    }
  })

  it('normalizes the backend origin and rejects unusable values', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
    assert.equal(normalizeBaseUrl(' https://cad.example.com/base/// '), 'https://cad.example.com/base')
    assert.throws(() => normalizeBaseUrl(''), /baseUrl is required/)
    assert.throws(() => normalizeBaseUrl('ftp://x'), /must use http or https/)
    assert.throws(() => normalizeBaseUrl('not a url'), /not a valid URL/)
    assert.throws(() => normalizeBaseUrl('https://user:password@example.com'), /must not contain username or password/)
  })

  it('reads both content-disposition filename forms', () => {
    assert.equal(fileNameFromDisposition('attachment; filename="a.dxf"'), 'a.dxf')
    assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E5%9B%BE%E7%BA%B8.dxf"), '图纸.dxf')
    assert.equal(fileNameFromDisposition(null), undefined)
  })
})

describe('CadTranslationClient against the mock backend', () => {
  let backend
  let workDir

  before(async () => {
    backend = await startMockBackend({
      adminToken: 'secret-token',
      tasks: [
        makeTask({ task_id: 'aaaa0001', original_filename: 'plan.dxf' }),
        makeTask({
          task_id: 'bbbb0002',
          status: 'processing',
          stage: 'translating',
          translated_count: 3,
          completed_chunks: 1,
          files: { excel_file: '/api/cad/download/bbbb0002/excel' },
        }),
      ],
    })
    workDir = await mkdtemp(join(tmpdir(), 'dsh-cad-client-'))
  })

  after(async () => {
    await backend.close()
    await rm(workDir, { recursive: true, force: true })
  })

  const client = (token = 'secret-token') => new CadTranslationClient({ baseUrl: backend.baseUrl, adminToken: token })

  it('sends the admin token the backend requires', async () => {
    await assert.rejects(client('').getTask('aaaa0001'), (error) => {
      assert.ok(error instanceof CadHttpError)
      assert.equal(error.status, 401)
      return true
    })
    const summary = await client().getTask('aaaa0001')
    assert.equal(summary.original_filename, 'plan.dxf')
  })

  it('uploads the drawing as multipart form data and returns the task id', async () => {
    const filePath = join(workDir, 'sample drawing.dxf')
    await writeFile(filePath, '0\nSECTION\nEOF\n')
    const result = await client().submitTranslation({
      filePath,
      targetLanguage: 'ja',
      converterBackend: 'dxf_only',
      translationMode: 'add',
    })
    assert.deepEqual(result, { taskId: '0badf00d', fileName: 'sample drawing.dxf' })
    const upload = backend.uploads.at(-1)
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/)
    assert.match(upload.body, /name="target_language"\r\n\r\nja/)
    assert.match(upload.body, /name="converter_backend"\r\n\r\ndxf_only/)
    assert.match(upload.body, /name="translation_mode"\r\n\r\nadd/)
    assert.match(upload.body, /name="background"\r\n\r\ntrue/)
    assert.match(upload.body, /name="file"; filename="sample drawing.dxf"/)
    assert.match(upload.body, /SECTION/)
  })

  it('names the unreadable drawing instead of failing inside FormData', async () => {
    await assert.rejects(
      client().submitTranslation({ filePath: join(workDir, 'gone.dxf'), targetLanguage: 'en' }),
      (error) => {
        assert.equal(error.name, 'CadFileError')
        assert.match(error.message, /no such file/)
        assert.ok(error.message.includes('gone.dxf'))
        return true
      },
    )
    await assert.rejects(
      client().submitTranslation({ filePath: workDir, targetLanguage: 'en' }),
      /not a regular file/,
    )
  })

  it('downloads an artifact under the backend-provided name', async () => {
    const file = await client().downloadArtifact({ taskId: 'aaaa0001', artifact: 'translated_cad', outputDir: workDir })
    assert.equal(file.fileName, 'drawing-translated.dxf')
    assert.equal(await readFile(file.path, 'utf8'), 'artifact:aaaa0001:translated_cad')
  })

  it('honours an explicit file name and reports a missing artifact as an HTTP error', async () => {
    const file = await client().downloadArtifact({
      taskId: 'bbbb0002',
      artifact: 'excel',
      outputDir: workDir,
      fileName: 'texts.xlsx',
    })
    assert.equal(file.fileName, 'texts.xlsx')
    await assert.rejects(
      client().downloadArtifact({ taskId: 'bbbb0002', artifact: 'translated_cad', outputDir: workDir }),
      (error) => error instanceof CadHttpError && error.status === 404,
    )
  })

  it('refuses path components from both callers and server headers', async () => {
    for (const fileName of ['../escape.dxf', '..\\escape.dxf', '/tmp/escape.dxf', 'C:escape.dxf', '..']) {
      await assert.rejects(client().downloadArtifact({ taskId: 'aaaa0001', artifact: 'excel', outputDir: workDir, fileName }), /plain file name/)
    }
    const malicious = new CadTranslationClient({
      baseUrl: 'http://backend.invalid',
      fetch: async () => new Response('data', { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''..%2Fescaped.dxf" } }),
    })
    await assert.rejects(malicious.downloadArtifact({ taskId: 'aaaa0001', artifact: 'excel', outputDir: workDir }), /plain file name/)
  })

  it('does not overwrite an existing artifact', async () => {
    const fileName = 'keep-existing.xlsx'
    const target = join(workDir, fileName)
    await writeFile(target, 'original')
    await assert.rejects(client().downloadArtifact({ taskId: 'aaaa0001', artifact: 'excel', outputDir: workDir, fileName }), error => error.code === 'EEXIST')
    assert.equal(await readFile(target, 'utf8'), 'original')
  })

  it('redacts echoed tokens in JSON and download errors', async () => {
    const secret = 'secret-token'
    for (const kind of ['json', 'non-json', 'download']) {
      const subject = new CadTranslationClient({ baseUrl: 'http://backend.invalid', adminToken: secret,
        fetch: async () => kind === 'json'
          ? Response.json({ detail: `invalid ${secret}` }, { status: 403 })
          : new Response(`invalid ${secret}`, { status: 403 }),
      })
      const action = kind === 'download' ? subject.downloadArtifact({ taskId: 'aaaa0001', artifact: 'excel', outputDir: workDir }) : subject.getTask('aaaa0001')
      await assert.rejects(action, error => {
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.detail.includes(secret), false)
        assert.match(error.detail, /\[REDACTED\]/)
        return true
      })
    }
  })

  it('redacts JSON-escaped tokens in nested error details', async () => {
    const secret = 'a"b\\c'
    const subject = new CadTranslationClient({ baseUrl: 'http://backend.invalid', adminToken: secret,
      fetch: async () => Response.json({ detail: { echoedToken: secret } }, { status: 403 }),
    })
    await assert.rejects(subject.getTask('aaaa0001'), error => {
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes(JSON.stringify(secret).slice(1, -1)), false)
      assert.match(error.message, /\[REDACTED\]/)
      return true
    })
  })

  it('never exposes tokens that coincide with or occur inside the redaction marker', async () => {
    for (const secret of ['REDACTED', '[REDACTED]', '█']) {
      const subject = new CadTranslationClient({ baseUrl: 'http://backend.invalid', adminToken: secret,
        fetch: async () => Response.json({ detail: `exposed ${secret}` }, { status: 403 }),
      })
      await assert.rejects(subject.getTask('aaaa0001'), error => {
        assert.equal(error.message.includes(secret), false)
        assert.equal(error.detail.includes(secret), false)
        return true
      })
    }
  })

  it('does not forward the admin token through redirects', async () => {
    let received = false
    const destination = createServer((req, res) => { received = true; res.end('{}') })
    await new Promise(done => destination.listen(0, '127.0.0.1', done))
    const redirect = createServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/stolen` })
      res.end()
    })
    await new Promise(done => redirect.listen(0, '127.0.0.1', done))
    try {
      const subject = new CadTranslationClient({ baseUrl: `http://127.0.0.1:${redirect.address().port}`, adminToken: 'secret-token' })
      await assert.rejects(subject.getTask('aaaa0001'))
      await assert.rejects(subject.downloadArtifact({ taskId: 'aaaa0001', artifact: 'excel', outputDir: workDir }))
      assert.equal(received, false)
    } finally {
      await Promise.all([new Promise(done => destination.close(done)), new Promise(done => redirect.close(done))])
    }
  })

  it('lists tasks and clamps the page size', async () => {
    const page = await client().listTasks({ limit: 100 })
    assert.equal(page.total, 2)
    assert.equal(page.tasks.length, 2)
  })

  it('reports an unreachable backend as a connection error, not a crash', async () => {
    const unreachable = new CadTranslationClient({ baseUrl: 'http://127.0.0.1:9', requestTimeoutMs: 2000 })
    await assert.rejects(unreachable.getTask('aaaa0001'), (error) => {
      assert.equal(error.name, 'CadConnectionError')
      assert.match(error.message, /cannot reach the CAD translation backend/)
      return true
    })
  })

  it('surfaces a non-JSON answer as an HTTP error instead of throwing a parse error', async () => {
    const client2 = new CadTranslationClient({
      baseUrl: 'http://backend.invalid',
      fetch: async () => new Response('<html>gateway</html>', { status: 200 }),
    })
    await assert.rejects(client2.getTask('aaaa0001'), /non-JSON output/)
  })

  it('forwards cancellation to fetch', async () => {
    const controller = new AbortController()
    const pending = client().getTask('aaaa0001', controller.signal)
    controller.abort()
    await assert.rejects(pending, error => error.name === 'AbortError')
  })
})
