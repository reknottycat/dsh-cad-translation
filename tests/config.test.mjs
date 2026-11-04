import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import plugin, { Config, createPlugin } from '../src/adapter.mjs'
import { resolveBackendConfig } from '../src/cad-translator.mjs'

describe('Cordis plugin configuration', () => {
  it('exposes the same schema on the default and named plugin instances', () => {
    assert.equal(plugin.Config, Config)
    assert.equal(createPlugin({ id: 'test' }).Config, Config)
  })

  it('accepts explicit backend settings and resolves them before environment settings', () => {
    const validated = Config({ backend: {
      baseUrl: 'http://127.0.0.1:7000',
      requestTimeoutMs: 4321,
      outputDir: 'configured-output',
    } })
    const resolved = resolveBackendConfig(validated, {
      CAD_TRANSLATION_BASE_URL: 'http://127.0.0.1:8000',
      CAD_TRANSLATION_TIMEOUT_MS: '9876',
      CAD_TRANSLATION_OUTPUT_DIR: 'environment-output',
      CAD_TRANSLATION_ADMIN_TOKEN: 'test-token',
    })
    assert.deepEqual(resolved, {
      baseUrl: 'http://127.0.0.1:7000',
      requestTimeoutMs: 4321,
      outputDir: 'configured-output',
      adminToken: 'test-token',
    })
  })

  it('rejects zero, negative and non-numeric request timeouts', () => {
    for (const timeout of [0, -1, 'invalid']) {
      assert.throws(() => Config({ backend: { requestTimeoutMs: timeout } }), /requestTimeoutMs/)
    }
  })

  it('does not let schema defaults override environment settings', () => {
    const validated = Config({})
    const resolved = resolveBackendConfig(validated, {
      CAD_TRANSLATION_BASE_URL: 'http://127.0.0.1:8123',
      CAD_TRANSLATION_TIMEOUT_MS: '9876',
      CAD_TRANSLATION_OUTPUT_DIR: 'environment-output',
      CAD_TRANSLATION_ADMIN_TOKEN: 'test-token',
    })
    assert.deepEqual(resolved, {
      baseUrl: 'http://127.0.0.1:8123',
      requestTimeoutMs: 9876,
      outputDir: 'environment-output',
      adminToken: 'test-token',
    })
  })
})
