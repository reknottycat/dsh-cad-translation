/**
 * Resolve `defineTool` from the DeepSeek Harness installation the plugin runs
 * inside.
 *
 * The plugin declares `@deepseek-ai/dsh-tools` as a peer dependency, but its
 * own package directory may sit outside the Harness `node_modules` tree (a
 * linked checkout, for example). Resolving from `DSH_HOME`/this file keeps the
 * single module instance the Host already loaded, and a failed resolution
 * reports the paths that were tried.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Directories to resolve Harness packages from, most specific first.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function harnessResolutionRoots(env = process.env) {
  const roots = []
  const home = env.DSH_HOME?.trim()
  if (home) roots.push(join(home, 'profiles'))
  try {
    // Node's own resolution: a plugin installed into a profile finds the
    // Harness packages in the profile's node_modules chain. `dsh-tools` is the
    // peer this plugin actually imports, so it anchors the search.
    roots.push(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json')))
  } catch {
    /* not resolvable from here; DSH_HOME may still be */
  }
  return roots
}

/**
 * Import a Harness package, preferring the copy that the running Host loaded.
 * @param {string} specifier
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<any>}
 */
export async function importHarnessModule(specifier, env = process.env) {
  const tried = []
  for (const root of harnessResolutionRoots(env)) {
    try {
      const resolved = createRequire(join(root, 'noop.js')).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      tried.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    return await import(specifier)
  } catch (error) {
    tried.push(`bare: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(
    `cannot resolve ${specifier} for the CAD translation plugin. `
    + 'Install the bundle into a DeepSeek Harness profile '
    + '(`dsh plugin --profile <name> add <package>`) or set DSH_HOME. Tried:\n'
    + tried.map(line => `  - ${line}`).join('\n'),
  )
}
