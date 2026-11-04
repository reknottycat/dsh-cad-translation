# DeepSeek Harness CAD translation plugin

Translate the text inside DXF/DWG drawings from a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
session, then download the translated drawing or the extracted text workbook.

The plugin is a thin consumer of the separately installed [CAD translation
backend](https://cnb.cool/star_fu/cad-translation-web). Conversion, text extraction, LLM translation and back-fill all stay in
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
| DeepSeek Harness (`dsh`) | `>=0.2.1-rc.1 <0.3.0`. Verified against `@deepseek-ai/dsh-tools@0.2.2-alpha.3`. |
| Node.js | Node 24 verified for Harness 0.2.1-rc.5. The standalone plugin tests also run on Node 22; Node 22.14 did not start the Harness CLI. |
| CAD translation backend | [CAD Translation System](https://cnb.cool/star_fu/cad-translation-web) FastAPI backend, reachable over HTTP and separately installed. |

Harness is in developer preview and breaks compatibility between releases; the
`engines.dsh` range is deliberately narrow. Re-run the tool contract tests
after upgrading Harness.

## Install

### 1. Install and start the backend

The backend is a separate project. Follow the setup and provider configuration
in the [CAD Translation System repository](https://cnb.cool/star_fu/cad-translation-web).
Start its backend on `http://127.0.0.1:8000`, or set the base URL below to
its actual address. A configured model provider is required for real translation.

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

The following commands are for macOS/Linux. Use Node 24 and a working `dsh`
installation, verified with Harness 0.2.1-rc.5. Clone this plugin repository and run from its root:

```bash
git clone https://github.com/reknottycat/dsh-cad-translation.git
cd dsh-cad-translation

# Select the same dsh installation for all commands.
DSH_BIN="$(command -v dsh)"
test -n "$DSH_BIN" || { echo "Install DeepSeek Harness first"; exit 1; }
"$DSH_BIN" plugin --profile web add ./
mkdir -p "$HOME/.config/dsh-cad-private"
chmod 700 "$HOME/.config/dsh-cad-private"
node scripts/build-profile-patch.cjs \
  "$DSH_BIN" web "$HOME/.config/dsh-cad-private/cad.patch.yml"
"$DSH_BIN" --profile web --patch "$HOME/.config/dsh-cad-private/cad.patch.yml" --no-open
```

Open the address printed by Harness, create a **standard** session, and ask it
to translate a DXF. The generated patch adds the tools to existing `standard`
and `cordis` presets without modifying the profile. It contains the complete
current preset configuration, potentially including private settings: keep it in
a private directory and do not commit it. It is created with mode 0600 and the
script refuses to overwrite an existing file. If the profile changes, generate
a new patch at a new path and launch with that path. Other presets are not
modified. This method is verified on Harness 0.2.1-rc.5; verify again after
upgrading Harness. The backend must be running and configured as described above.

Windows users can run the same steps in a shell with Node 24; pass the absolute
path to the real dsh JavaScript entry point to the generator. Windows-specific
installation and DWG conversion have not yet been verified.

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
* The token travels as the `X-Admin-Token` header on every request. It is not
  logged, not stored in the session, and not included in tool output or error
  messages.
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

The offline test suite runs with `node --test tests/*.test.mjs`. To run the
Harness contract suites, install the compatible `@deepseek-ai/dsh-tools` peer
in an isolated checkout and rerun the tests:

```bash
npm install --no-save --no-package-lock --ignore-scripts @deepseek-ai/dsh-tools@0.2.2-alpha.3
node --test tests/*.test.mjs
```

The optional backend end-to-end
suite needs a separately running backend, a configured provider and `ezdxf`:

```bash
CAD_E2E_BASE_URL=http://127.0.0.1:8000 \
CAD_E2E_ADMIN_TOKEN="your-backend-admin-token" \
CAD_E2E_TRANSLATE=1 CAD_E2E_PYTHON=/path/to/backend/python \
node --test tests/backend-e2e.test.mjs
```

The source plugin was developed in the CAD Translation System
[PR #40](https://cnb.cool/star_fu/cad-translation-web/-/pulls/40), based on
commit `13a6f7c`. That PR is not yet merged. With Harness 0.2.1-rc.5 and
Node 24 on macOS, a real Harness session called all three tools against the
real backend and DeepSeek, translated three DXF text entities to Chinese and
downloaded a DXF whose text was independently checked with ezdxf. Windows and
DWG conversion were not tested. See [the verification record](docs/dsh-plugin.md).

## Repository layout

```
dsh-cad-translation/
├── package.json          # dsh.bundle manifest + engines.dsh range
├── patches/presets.patch.yml   # empty bundle patch; profile patch is generated separately
├── scripts/build-profile-patch.cjs  # generates the profile patch
├── src/
│   ├── cad-translator.mjs # the three tools (defineTool registrations)
│   ├── adapter.mjs        # Cordis plugin that names each mounted row
│   └── dsh-tools.mjs      # resolves @deepseek-ai/dsh-tools from the running Host
├── client.mjs             # backend HTTP client (upload / task / download)
├── locale/{en,zh}.json    # plugin display metadata
├── docs/dsh-plugin.md     # integration design + verification record
└── tests/                 # node:test suites + mock backend
```
