/**
 * End-to-end test against a *real* CAD translation backend.
 *
 * Opt-in: set both variables below to run it.
 *
 *   CAD_E2E_BASE_URL=http://127.0.0.1:8000
 *   CAD_E2E_ADMIN_TOKEN=<the backend's ADMIN_API_TOKEN>
 *   CAD_E2E_DRAWING=/path/to/drawing.dxf      # optional, default tests/fixtures/building_a.dxf
 *
 * The default drawing is one of the repository's DXF fixtures, so the extract
 * and back-fill stages run without AutoCAD, ODA or an LLM key when the backend
 * is started with `extract_only` — pass CAD_E2E_TRANSLATE=1 to run the full
 * translation, which needs a configured model provider.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { CadHttpError, CadTranslationClient } from '../client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const baseUrl = process.env.CAD_E2E_BASE_URL
const drawing = process.env.CAD_E2E_DRAWING || join(here, 'fixtures/building_a.dxf')
const translate = process.env.CAD_E2E_TRANSLATE === '1'

const options = baseUrl === undefined
  ? { skip: 'set CAD_E2E_BASE_URL (and CAD_E2E_ADMIN_TOKEN) to run the backend end-to-end test' }
  : {}

describe('real CAD translation backend', options, () => {
  /** @type {CadTranslationClient} */
  let client
  let workDir

  before(async () => {
    client = new CadTranslationClient({
      baseUrl,
      adminToken: process.env.CAD_E2E_ADMIN_TOKEN ?? '',
      requestTimeoutMs: 60_000,
    })
    workDir = await mkdtemp(join(tmpdir(), 'dsh-cad-e2e-'))
  })

  after(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('answers the public health route', async () => {
    const payload = await client.request('/api/cad/health')
    assert.equal(payload.success, true)
  })

  it('lists the supported target languages', async () => {
    const payload = await client.getLanguages()
    assert.ok(Object.keys(payload.languages).includes('en'))
  })

  it('queues one drawing and follows it to a settled state', async (t) => {
    const { taskId } = await client.submitTranslation({
      filePath: drawing,
      targetLanguage: translate && !process.env.CAD_E2E_DRAWING ? 'zh' : 'en',
      converterBackend: 'dxf_only',
      extractOnly: !translate,
    })
    assert.match(taskId, /^[0-9a-f]{8}$/)

    const deadline = Date.now() + 5 * 60_000
    let summary = await client.getTask(taskId)
    while (!['done', 'partial', 'error', 'cancelled'].includes(summary.status)) {
      if (Date.now() > deadline) {
        t.diagnostic(`task ${taskId} still ${summary.status}/${summary.stage} after 5 minutes`)
        break
      }
      await new Promise(done => setTimeout(done, 1000))
      summary = await client.getTask(taskId)
    }
    t.diagnostic(`task ${taskId}: status=${summary.status} stage=${summary.stage} texts=${summary.text_count}`)
    if (summary.status === 'error') {
      // A backend without a configured provider fails here; that is the
      // backend's state, not a plugin defect, so report it instead of passing.
      assert.fail(`backend reported error: ${summary.last_error}`)
    }
    assert.ok(['done', 'partial'].includes(summary.status), `unexpected status ${summary.status}`)
    assert.ok(summary.text_count >= 0)

    const excel = await client.downloadArtifact({ taskId, artifact: 'excel', outputDir: workDir })
    assert.ok(readFileSync(excel.path).length > 0, 'the extracted workbook must not be empty')
    t.diagnostic(`downloaded ${excel.fileName} (${readFileSync(excel.path).length} bytes)`)

    if (translate) {
      const cad = await client.downloadArtifact({ taskId, artifact: 'translated_cad', outputDir: workDir })
      assert.ok(readFileSync(cad.path).length > 0, 'the translated drawing must not be empty')
      if (!process.env.CAD_E2E_DRAWING) {
        const python = process.env.CAD_E2E_PYTHON || 'python3'
        const script = 'import ezdxf,json,sys\nprint(json.dumps([[e.dxf.text for e in ezdxf.readfile(p).modelspace().query("TEXT")] for p in sys.argv[1:]], ensure_ascii=False))'
        const [before, after] = JSON.parse(execFileSync(python, ['-c', script, drawing, cad.path], { encoding: 'utf8' }))
        assert.ok(after.length >= before.length && before.length > 0, 'translated DXF must retain TEXT entities')
        assert.ok(after.some((text, i) => text !== before[i] && /[\u4e00-\u9fff]/.test(text)), 'translated DXF must contain changed Chinese text')
      }
      t.diagnostic(`downloaded ${cad.fileName}`)
    }
  })

  it('reports an unknown task as an HTTP 404', async () => {
    await assert.rejects(client.getTask('00000000'), (error) => {
      assert.ok(error instanceof CadHttpError)
      assert.equal(error.status, 404)
      return true
    })
  })

  it('refuses a task id that the backend would reject', async () => {
    await assert.rejects(client.getTask('../etc/passwd'), /taskId must be/)
  })
})
