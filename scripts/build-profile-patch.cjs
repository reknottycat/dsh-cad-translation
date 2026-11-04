#!/usr/bin/env node
'use strict';
// Generate a separate, reviewable patch from a profile's current composed tree.
// Run with the same Node version that starts dsh. Does not edit the profile.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createRequire } = require('node:module');

function main() {
  const [dshExecutable, profile, destination, ...extra] = process.argv.slice(2);
  if (!dshExecutable || !profile || !destination || extra.length || profile.startsWith('-')) {
    throw new Error('Usage: node build-profile-patch.cjs <absolute-dsh-executable> <profile> <new-patch-file>');
  }
  if (!path.isAbsolute(dshExecutable)) throw new Error('dsh executable must be an absolute path');
  const cli = fs.realpathSync(dshExecutable);
  const yaml = createRequire(cli)('js-yaml');
  class Expression { constructor(value) { this.value = value; } }
  const tag = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: value => new Expression(value),
    instanceOf: Expression, represent: expression => expression.value,
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([tag]);
  const raw = cp.execFileSync(process.execPath, [cli, '--profile', profile, '--dump-config'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tree = yaml.load(raw, { schema });
  if (!Array.isArray(tree)) throw new Error('Unexpected dsh config tree');
  if (tree.some(row => row && row.name === 'dsh-cad-translation/translator')) {
    throw new Error('CAD tool is incorrectly mounted at host root; remove the old bundle patch before proceeding');
  }
  const patch = [];
  for (const id of ['preset-standard', 'preset-cordis']) {
    const matches = tree.filter(row => row && row.id === id);
    if (matches.length === 0) continue;
    if (matches.length !== 1 || !Array.isArray(matches[0].config?.plugins)) throw new Error(`Unexpected preset ${id}`);
    const config = matches[0].config;
    const existing = config.plugins.filter(row => row?.id === 'tool-cad-translation');
    if (existing.length) {
      if (existing.length !== 1 || existing[0].name !== 'dsh-cad-translation/translator') throw new Error(`Conflicting tool id in ${id}`);
    } else config.plugins.push({ id: 'tool-cad-translation', name: 'dsh-cad-translation/translator' });
    patch.push({ id, config });
  }
  if (!patch.length) throw new Error('Profile has no supported standard or cordis preset');
  const content = yaml.dump(patch, { schema, lineWidth: -1, noRefs: true });
  // Exclusive creation: never overwrite a user's file.
  fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${destination} for profile ${profile}; presets: ${patch.map(p => p.id).join(', ')}`);
}
try { main(); } catch (error) { console.error(`Cannot create CAD profile patch: ${error.message}`); process.exitCode = 1; }
