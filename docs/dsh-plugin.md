# DeepSeek Harness integration design

How the plugin binds this repository's CAD translation backend to DeepSeek
Harness, which backend routes it uses, and what was actually verified.

## Target platform identification

"DeepSeek Harness" is a real, distinct product, not the DeepSeek chat app and
not an alias for the DeepSeek API:

| Fact | Evidence |
|------|----------|
| Repository | `github.com/deepseek-ai/deepseek-harness` (MIT), default branch `master` |
| Self-description | "DeepSeek Harness: Everything is a Plugin." built on Cordis |
| Docs | `https://deepseek-harness.github.io/deepseek-harness/` |
| Run | `npx @deepseek-ai/dsh web` → Web UI on `http://127.0.0.1:3080` |
| Plugin distribution | npm packages with a `dsh.bundle` manifest; install with `dsh plugin --profile <name> add <pkg>` |
| Extension points used here | `ctx.tools.register(...)` + `defineTool` from `@deepseek-ai/dsh-tools` |

The plugin is a *tool plugin*: Harness exposes capabilities to the model as
registered tools, so the CAD pipeline appears as three tools the model can call
inside a normal session. Nothing in the plugin depends on the DeepSeek chat
product, the DeepSeek API, or function calling.

The supported Harness version is 0.2.1-rc.5; the contract suite also uses the matching dsh-tools version.

## Why a tool plugin

Harness routes "add a model-facing capability" to `ctx.tools.register`; its
architecture doc lists that as the extension point for new agent behaviour, and
the tool schema joins system-prompt assembly automatically. The alternative
surfaces (command, service, MCP client) either need a human to type a command
or add a server process for no benefit here.

## Composition

The bundle inserts one Host-level `dsh-cad-translation/translator` row. Its
three tools are registered once and are inherited by agent scopes unless a
preset restricts or shadows them. This follows the official
[subagent-codex bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/subagent/subagent-codex/cordis.patch.yml).
The prior version mounted the tools through a generated preset patch; remove
that old `--patch` argument when upgrading to avoid duplicate registration.

## Backend routes used

All routes are existing public API; no backend code was changed.

| Plugin call | Backend route | Notes |
|---|---|---|
| `cad_translate` | `POST /api/cad/upload` (multipart) | `background=true`, returns `202`-style `{ success, data: { task_id, status, stage } }` |
| `cad_translation_status` (one) | `GET /api/cad/tasks/{task_id}` | Wrapped in `data`; `files.excel_file` / `files.translated_cad_file` say which artifacts exist |
| `cad_translation_status` (log) | `GET /api/cad/tasks/{task_id}/logs` | Text log |
| `cad_translation_status` (list) | `GET /api/cad/tasks?limit=&offset=` | Newest activity first |
| `cad_download_drawing` | `GET /api/cad/download/{task_id}/{excel\|translated_cad}` | Streams the file; `Content-Disposition` supplies the name |

Every route except `/api/translation/languages` and `/api/cad/health` sits
behind `require_admin_access`, so the plugin sends `X-Admin-Token` when a token
is configured.

## Failure handling

| Situation | Plugin behaviour |
|---|---|
| Backend unreachable | `CadConnectionError` → tool error telling the user to start the backend and check `baseUrl` |
| `401`/`403` | Tool error naming `CAD_TRANSLATION_ADMIN_TOKEN` |
| `503` | Tool error explaining the backend has the guard on but no `ADMIN_API_TOKEN` |
| `404` (unknown task, missing artifact) | Tool error quoting the backend detail; the download tool pre-checks `files.*` so the model learns the task has not finished |
| Task `error`/`cancelled` | Download refuses and reports `last_error` |
| Malformed task id | Rejected before any path is built |
| Drawing path missing / unreadable / a directory | `CadFileError` before the upload: the message names the absolute path actually tried and the reason (`no such file`, `permission denied`, `not a regular file`) |
| Caller cancellation | `exec.signal` forwarded to every request, including the upload and the download stream |

Tool bodies throw on failure, which Harness records as `isError`; successes
return a canonical JSON value plus a rendered one-line summary.

## Secret handling

The admin token comes from `CAD_TRANSLATION_ADMIN_TOKEN` (or the row config) and
is read on each call, so an operator can set it without restarting the Host. It
is placed in the `X-Admin-Token` header only; it never appears in tool output,
error messages, the session log, or the repository. LLM credentials are not
involved at all — they stay with the backend.

## Current verification

On macOS with Node 24.22.2 and Harness 0.2.1-rc.5, the linked checkout was
installed after its production dependencies. A real headless session called all
three tools against the actual backend and DeepSeek, translated three English
DXF text entities into Chinese, and downloaded a DXF whose contents were
checked with ezdxf. A fresh Web profile started successfully; a Web session
was not exercised for this release. Windows and DWG remain unverified.

## Previous verification record (earlier release)

Run on Linux, Node.js 26.13.0, `@deepseek-ai/dsh-tools@0.2.2-alpha.3`, and this
repository's backend on `python3.11` + FastAPI.

### Offline suite — 12 tests, all passing, no Harness required

```
node --test tests/*.test.mjs
```

Covers: task-id shape, base URL normalisation, `Content-Disposition` parsing,
admin-token header, multipart upload body (fields and file part), unreadable
drawing pre-flight, download file naming, 404 propagation, unreachable-host
mapping, non-JSON response handling, cancellation forwarding.

### Plugin + contract suite — 33 tests, all passing

```
node scripts/dsh_plugin_test.mjs --network   # 33 pass, 0 fail
```

Also run green on Node.js 20.20.2, the runtime the CNB CI image uses.

The extra 20 tests run against the real `@deepseek-ai/dsh-tools`:

* registered tool names, `isConcurrencySafe`, and canonical output shapes;
* model arguments validated by the real `validateJsonSchemaValue` against the
  compiled parameter schema, and tool values validated against the compiled
  output schema;
* `cad_translate` → queued id, `cad_translation_status` → single/list/log,
  `cad_download_drawing` → file on disk, through an in-process mock backend;
* relative paths resolved against the Session working directory;
* error paths: missing drawing, directory instead of a file, failed task,
  not-yet-produced artifact, malformed task id.

Without a Harness installation the same command reports 11 passing tests and
skips the three dependent suites with an explanation, so CI stays green in a
plain Node container.

### Real-backend end-to-end

Backend started from this repository with `ENABLE_ADMIN_GUARD=false`,
`ASYNC_TASKS_MODE=local`, and `extract_only` (no CAD converter, no LLM key):

```
CAD_E2E_BASE_URL=http://127.0.0.1:8021 node --test tests/backend-e2e.test.mjs
  ✔ answers the public health route
  ✔ lists the supported target languages
  ✔ queues one drawing and follows it to a settled state
      task 8e90104c: status=done stage=completed texts=3
      downloaded building_a_extracted_texts.xlsx (5230 bytes)
  ✔ reports an unknown task as an HTTP 404
  ✔ refuses a task id that the backend would reject
```

The three tools were also driven directly against that backend
(`tests/fixtures/building_a.dxf`):

```
cad_translate        → task 9a9cf7ca queued
cad_translation_status → status=done stage=completed texts=3
cad_download_drawing → /tmp/.../building_a_extracted_texts.xlsx (5230 bytes)
```

A second backend instance with `ENABLE_ADMIN_GUARD=true` and
`ADMIN_API_TOKEN=e2e-secret-token` confirmed the guard path: no token → `403`
with a hint naming the variable, wrong token → `403`, correct token → the task
list. The token value never appeared in any tool message.

### Previous verification (macOS, generated-patch implementation)

With Python 3.12 and Node 22, a real DeepSeek model translated the DXF fixture
into Chinese; the downloaded DXF was read with ezdxf and all three English
TEXT entities were confirmed changed. The opt-in test now asserts this behavior.
Harness 0.2.1-rc.5 was started using Node 24 with a generated profile patch;
a standard session installed from the packed plugin called all three tools against
the real backend and DeepSeek model. The task completed with three translated
texts and zero failures; the downloaded DXF was independently inspected with
ezdxf and confirmed to contain all three Chinese translations.

### Not verified

* DWG input: a supported converter was unavailable on the test host.
* Windows installation, runtime and DWG conversion.
