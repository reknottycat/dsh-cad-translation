/**
 * Contract tests that pin the DeepSeek Harness interfaces this plugin depends
 * on. They run only when `@deepseek-ai/dsh-tools` is resolvable (a Harness
 * profile or a checkout), and skip with instructions otherwise, so the rest of
 * the suite stays runnable on a machine without the Harness installed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../src/cad-translator.mjs'
import { importHarnessModule } from '../src/dsh-tools.mjs'

/** Resolve the Harness module, or a reason to skip. */
async function tryHarness() {
  try {
    return { module: await importHarnessModule('@deepseek-ai/dsh-tools') }
  } catch (error) {
    return { skip: error.message.split('\n')[0] }
  }
}

const harness = await tryHarness()
const harnessOptions = harness.skip === undefined
  ? {}
  : { skip: `@deepseek-ai/dsh-tools is not installed here: ${harness.skip}. Run this suite from a Harness profile or export DSH_HOME.` }

describe('DeepSeek Harness tool contract', harnessOptions, () => {
  it('exposes defineTool and validateJsonSchemaValue from the package root', () => {
    assert.equal(typeof harness.module.defineTool, 'function')
    assert.equal(typeof harness.module.validateJsonSchemaValue, 'function')
  })

  it('keeps the definition shape the plugin relies on', () => {
    const definition = harness.module.defineTool({
      name: 'contract_probe',
      description: 'Probe the tool definition contract.',
      parameters: { flag: { type: 'boolean' }, count: { type: 'integer' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      isConcurrencySafe: args => args.flag === true,
      async execute() { return { ok: true } },
    })
    for (const key of ['name', 'description', 'parameters', 'output', 'execute', 'isConcurrencySafe']) {
      assert.ok(key in definition, `definition.${key}`)
    }
    assert.equal(definition.isConcurrencySafe({ flag: true }), true)
    assert.equal(definition.isConcurrencySafe({ flag: false }), false)
  })

  it('validates arguments against the compiled parameter schema', async () => {
    const collected = []
    await apply({ tools: { register: definition => collected.push(definition) } }, {})
    const translate = collected.find(entry => entry.name === 'cad_translate')
    const { validateJsonSchemaValue } = harness.module
    assert.deepEqual(validateJsonSchemaValue(translate.parameters, { file_path: '/tmp/a.dxf', target_language: 'en' }, ''), [])
    const missing = validateJsonSchemaValue(translate.parameters, { file_path: '/tmp/a.dxf' }, '')
    assert.equal(missing.length, 1)
    assert.match(missing[0], /target_language/)
  })

  it('compiles each declared output schema into a validating JSON Schema', async () => {
    const collected = []
    await apply({ tools: { register: definition => collected.push(definition) } }, {})
    const { validateJsonSchemaValue } = harness.module
    for (const definition of collected) {
      assert.equal(definition.output.schema.type, 'object', definition.name)
      assert.equal(definition.output.schema.additionalProperties, false, definition.name)
      assert.ok(Array.isArray(definition.output.schema.required), definition.name)
      // An empty object must fail: every declared field is required by design.
      assert.ok(validateJsonSchemaValue(definition.output.schema, {}, 'value').length > 0, definition.name)
    }
  })
})
