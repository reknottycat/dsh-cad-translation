# DeepSeek Harness CAD translation plugin

Translate the text inside DXF/DWG drawings from a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
session, then download the translated drawing or the extracted text workbook.

The plugin is a thin consumer of the separately installed [CAD Translation System](https://cnb.cool/star_fu/cad-translation-web)
backend. Conversion, text extraction, LLM translation and back-fill all stay in
the backend's own async task pipeline; the plugin only uploads a drawing,
follows the task, and fetches the finished artifacts.

## What it adds

| Tool | Purpose |
|------|---------|
| `cad_translate` | Upload a local `.dxf`/`.dwg`, choose the target language, get a task id. |
| `cad_translation_status` | Read one task's status/stage/progress, optionally its log tail; list recent tasks when no id is given. |
| `cad_download_drawing` | Save the back-filled drawing (`translated_cad`) or the text workbook (`excel`) locally. |

## Requirements

| Item | Version / note |
|------|----------------|
| DeepSeek Harness (`dsh`) | `0.2.1-rc.5` (the supported and tested version). |
| Node.js | Node 24 verified for Harness 0.2.1-rc.5. The standalone plugin tests also run on Node 22; Node 22.14 did not start the Harness CLI. |
| CAD translation backend | The separately installed [CAD Translation System](https://cnb.cool/star_fu/cad-translation-web) FastAPI backend. |

Harness is in developer preview and can break compatibility between releases.
The package is restricted to the verified version. The `--network` test uses
the pinned rc.5 tools and does not verify a newer Harness; upgrading requires
testing installation and a real session against the target version.

## Install

### 1. Start the backend

Install and start the [CAD Translation System backend](https://cnb.cool/star_fu/cad-translation-web).
Configure a model provider for full translation; the backend runs separately.

### 2. Provide the connection settings

The plugin reads them from the environment, so a profile patch never carries a
secret. Set them before starting `dsh`:

```bash
export CAD_TRANSLATION_BASE_URL=http://127.0.0.1:8000     # default
export CAD_TRANSLATION_ADMIN_TOKEN="your-backend-admin-token" # replace with your configured token
export CAD_TRANSLATION_TIMEOUT_MS=120000                   # optional, per HTTP request
export CAD_TRANSLATION_OUTPUT_DIR=.cad-translation          # optional, default download dir
```

### 3. Install and load in Harness

The following commands are for macOS/Linux. Use Node 24, Harness 0.2.1-rc.5,
and pnpm on PATH. Run from the repository root:

```bash
git clone https://github.com/reknottycat/dsh-cad-translation.git
cd dsh-cad-translation
npm install --omit=dev --ignore-scripts --no-package-lock
dsh plugin --profile web add ./
dsh --profile web --no-open
```

Open the address printed by Harness and start a session. The bundle registers
its tools once in the Host registry: agent presets inherit them unless they
restrict or shadow those tools. Restart Harness after installing or removing the
bundle. Users of the previous generated profile patch should stop passing that
patch when upgrading to this version to avoid duplicate registration.
Windows installation and DWG conversion have not yet been verified.

## Use

Start a session and ask in natural language:

> Translate `~/projects/plan.dxf` to Japanese, then save the result next to the original.

The model calls `cad_translate`, then polls `cad_translation_status`, then calls
`cad_download_drawing`. You can also ask directly:

```
List my recent CAD translation tasks.
Show the log of task 0badf00d.
Download the extracted text workbook of task 0badf00d into ./out.
```

Statuses reported: `queued`, `processing`, `done`, `partial`, `error`,
`cancelled`. A task is settled once it reaches `done`, `partial`, `error` or
`cancelled`; anything else is still running. `partial` means some text failed to
translate, and `failed_count` says how many.

## How paths resolve

* An absolute `file_path` is used as given.
* A relative `file_path` resolves against the Session working directory.
* Downloads go to `output_dir`, or to `CAD_TRANSLATION_OUTPUT_DIR` /
  `backend.outputDir` (default `.cad-translation`) under the Session working
  directory.
* The backend checks the upload extension (`.dxf`/`.dwg`), size
  (`MAX_FILE_SIZE`, 100 MB by default) and task ids (8 hex characters) itself;
  the plugin repeats the task-id check so a mistyped value never becomes part of
  a download path.

## Credentials

* `CAD_TRANSLATION_ADMIN_TOKEN` is the backend's `ADMIN_API_TOKEN`, not an LLM
  key. LLM credentials stay in `backend/.env` or the backend's runtime config
  and never reach the plugin.
* The token travels as the `X-Admin-Token` header. Exact token values in returned strings and error messages are
  redacted; schema field names are unchanged, and transformed or partial values
  echoed by a server cannot be reliably recognized.
* With `ENABLE_ADMIN_GUARD=true` and no `ADMIN_API_TOKEN`, the backend rejects
  every protected route with `503`; the plugin reports that as an actionable
  error instead of retrying.
* Nothing is written to the repository. Downloaded drawings land wherever
  `output_dir` points; keep private drawings out of committed directories.

## Limitations

* **The backend must run somewhere reachable.** Uploads go over plain HTTP; put
  TLS in front of the backend for anything other than a local or trusted
  network.
* **DWG conversion depends on the backend host.** DWG input needs AutoCAD,
  Gmei/浩辰, ODA File Converter, or the bundled LibreDWG on the backend machine.
  `converter_backend: "dxf_only"` skips conversion entirely and is what the
  tests use.
* **Translation needs a configured provider.** Without an LLM provider the task
  ends in `error`; `extract_only: true` still produces the workbook.
* **Downloads do not overwrite existing files.** Choose a different file name or output directory when the target exists. Backend URLs must point directly to the service: redirects are rejected.
* **Files are uploaded, not linked.** The plugin reads the file from disk and
  sends it to the backend, so very large drawings cost one upload per task.
* **No cancel/delete tools.** The backend exposes stop/delete routes, but they
  are not wrapped here; ask the backend UI or API for those.
* **One task at a time per call.** `cad_translate` queues and returns
  immediately (`background=true`); there is no client-side waiting or progress
  streaming, so the model polls.
* **UI cards are generic.** The tools declare no `presentCall`/`presentResult`
  projections, so the Web client renders the default card with the model-facing
  text.

## Development and verification

```bash
npm install --ignore-scripts --no-package-lock
npm test
node scripts/dsh_harness_smoke.mjs
```

The smoke installs fixed Node, pnpm and Harness versions in a temporary directory,
then installs the packed plugin and checks a real session with a local fake
model and backend. It requires network access, but no model API key.

The source integration is maintained in [CNB PR #40](https://cnb.cool/star_fu/cad-translation-web/-/pulls/40), currently unmerged.
Real translation was verified on macOS with Node 24 and Harness 0.2.1-rc.5;
see [the verification record](docs/dsh-plugin.md).

## Repository layout

```
dsh-cad-translation/
├── package.json          # dsh.bundle manifest + engines.dsh range
├── patches/presets.patch.yml   # registers the Host tool plugin once
├── scripts/dsh_harness_smoke.mjs  # real Harness smoke test
├── src/
│   ├── cad-translator.mjs # the three tools (defineTool registrations)
│   ├── adapter.mjs        # Cordis plugin that names each mounted row
│   └── dsh-tools.mjs      # resolves @deepseek-ai/dsh-tools from the running Host
├── client.mjs             # backend HTTP client (upload / task / download)
├── locale/{en,zh}.json    # plugin display metadata
├── docs/dsh-plugin.md     # integration design + verification record
└── tests/                 # node:test suites + mock backend
```
