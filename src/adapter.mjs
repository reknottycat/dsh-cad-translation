/**
 * Cordis plugin that names one mounted CAD tool row.
 *
 * A Loader row's configuration cannot rename its plugin, so the row `id` is
 * folded into the runtime name here. Each mounted row then registers and logs
 * as `cad-translation/<id>` instead of sharing the package identity, which
 * keeps sibling rows distinguishable in Harness diagnostics.
 */

import { apply as applyTools, inject, namespacedName } from './cad-translator.mjs'
import Schema from '@deepseek-ai/schemastery'

// Leave defaults unset so environment variables remain effective.
export const Config = Schema.object({
  id: Schema.string(),
  backend: Schema.object({
    baseUrl: Schema.string(),
    requestTimeoutMs: Schema.number().min(1),
    outputDir: Schema.string(),
  }),
})

/**
 * Row configuration: the Cordis row id plus the backend settings.
 *
 * @typedef {object} AdapterConfig
 * @property {string} id Row id injected by the bundle patch.
 * @property {object} [backend] Backend connection settings.
 */

/** The Loader waits for the tool registry before applying the row. */
export { inject }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {AdapterConfig} [config]
 */
export function apply(ctx, config = {}) {
  return applyTools(ctx, config)
}

/**
 * Build the nameable plugin for one row.
 * @param {AdapterConfig} config
 */
export function createPlugin(config = {}) {
  return { name: namespacedName(config.id), inject, Config, apply }
}

/** Row-agnostic default plugin; the bundle patch mounts `createPlugin` instead. */
const plugin = { name: 'cad-translation', inject, Config, apply }

export default plugin
