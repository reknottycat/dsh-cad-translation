#!/usr/bin/env node
/** Real Harness smoke: isolated npm install, bundled plugin, local fake model and CAD API. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = root
const scratch = await mkdtemp(join(tmpdir(), 'dsh-harness-smoke-'))
let server
function run(command, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    let out = '', err = ''
    const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveRun({ out, err }) : reject(new Error(`${command} failed (${code}): ${err.slice(-4000)}\n${out.slice(-4000)}`)) })
  })
}
function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}
try {
  let messages = 0, toolSeen = false, cadCalls = 0, toolResultSeen = false
  server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/cad/tasks')) {
        cadCalls++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: [], total: 0 }))
        return
      }
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', object: 'model' }] }))
        return
      }
      if (req.url !== '/anthropic/v1/messages') { res.writeHead(404); res.end(); return }
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      messages++
      toolSeen ||= (request.tools ?? []).some(tool => tool.name === 'cad_translation_status')
      toolResultSeen ||= JSON.stringify(request.messages).includes('tool_result')
      const start = { type: 'message_start', message: { id: `msg_${messages}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }
      const events = messages === 1 ? [start,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_smoke', name: 'cad_translation_status', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ] : [start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Smoke complete.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ]
      sse(res, events)
    } catch (error) { res.destroy(error) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  console.log('Installing fixed Node, pnpm and Harness versions in a temporary directory...')
  await run('npm', ['install', '--prefix', scratch, '--no-audit', '--no-fund', '--ignore-scripts', 'node@24.22.2', 'pnpm@11.25.0', '@deepseek-ai/dsh@0.2.1-rc.5'])
  // The node npm package uses an install script to place its executable, so install it separately.
  await run('npm', ['rebuild', '--prefix', scratch, 'node'])
  const node = join(scratch, 'node_modules/node/bin/node')
  const bin = join(scratch, 'node_modules/.bin')
  const env = { ...process.env, PATH: [dirname(node), bin, process.env.PATH ?? ''].join(delimiter), DSH_HOME: join(scratch, 'home'), DEEPSEEK_API_KEY: 'local-smoke-only', DEEPSEEK_BASE_URL: `${url}/anthropic`, CAD_TRANSLATION_BASE_URL: url }
  const packed = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch, '--silent'], { cwd: plugin, env })
  const tar = join(scratch, packed.out.trim().split('\n').at(-1))
  const dsh = join(scratch, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  await run(node, [dsh, 'plugin', '--profile', 'headless', 'add', tar], { cwd: scratch, env })
  console.log('Running a real headless Harness session against a local fake model and CAD backend...')
  const session = await run(node, [dsh, 'headless', '--json', 'List recent CAD tasks.'], { cwd: scratch, env })
  assert(toolSeen, 'CAD tool was absent from model tool schema')
  assert(cadCalls === 1, `expected one CAD backend request, got ${cadCalls}`)
  assert(toolResultSeen, 'tool result was not returned to the model')
  assert(session.out.includes('"tool":"cad_translation_status"'), 'session did not invoke CAD tool')
  assert(!session.err.includes('entry did not activate'), 'Harness reported a failed plugin')
  console.log('PASS: packaged plugin installed, registered, invoked and returned a result.')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) }
  if (process.env.DSH_SMOKE_KEEP) console.log(`Scratch retained: ${scratch}`)
  else await rm(scratch, { recursive: true, force: true })
}
