# Harnesses

Each adapter translates the same portable settings (`model`, `tools`, `allow_bash`, MCP servers, skills) into the harness's native configuration, and normalises the harness's event stream into one execution log (`report/execution.jsonl`).

| | OpenCode 2 (default) | OpenCode 1 (`harness_version: 1`) | Codex | Pi | claw-code |
|---|---|---|---|---|---|
| package | `@opencode/cli` | `opencode-ai` | `@openai/codex` | `@earendil-works/pi-coding-agent` | source (cargo) |
| command | `opencode run --format json --auto` (through its background service) | `opencode run --format json` | `codex exec --json -` (prompt on stdin) | `pi --mode json --session-dir …` | `claw --output-format json prompt --stdin` |
| config | `~/.config/opencode/opencode.json` in the isolated home (`providers`, ordered `permissions`, `mcp.servers`) | `OPENCODE_CONFIG_CONTENT` (merged on the repo's) | private `CODEX_HOME/config.toml` | private `PI_CODING_AGENT_DIR` | `~/.claw.json` in the isolated home |
| `read-only` | `edit`/`shell`/`webfetch`/`websearch` denied | `edit`/`bash`/`webfetch` denied | `sandbox_mode = read-only` | `--tools read,grep,find,ls,mcp__*` | `workspace-write` + `--allowedTools` read tools + harness MCP tools |
| `edit` | `edit` allowed, `shell` per `allow_bash` pattern | `edit` allowed, bash per `allow_bash` pattern | `workspace-write`, network off | `+ edit,write` (+ `bash` if `allow_bash`) | `workspace-write` |
| `full` | everything allowed (questions denied) | everything allowed | `danger-full-access` | `+ bash` | `danger-full-access` |
| skills | `~/.agents/skills` + the repo's `.opencode`/`.claude`/`.agents` | same | `~/.agents/skills` + repo `.agents/skills` | `~/.agents/skills` + repo `.agents`/`.pi` | `~/.claw/skills` + repo `.claw`/`.agents`/`.claude` |
| MCP tool names | `harness_<tool>` | `harness_<tool>` | `harness.<tool>` (namespace) | `mcp__harness__<tool>` | `mcp__harness__<tool>` (deferred) |
| resume (loop, conversation) | `-s <id>`; `session export` / `session import` | `-s <id>`; `export` / `import` | `exec resume <id>`; `CODEX_HOME/sessions` | `--session <id>`; the session dir | — (earlier replies as context) |
| cost | per step | per step | — | per message | estimate at the end |

Skills committed to the repository in **any** of `.agents/`, `.claude/`, `.opencode/`, `.claw/`, `.codex/`, `.pi/skills` are copied to the isolated home, so every harness sees them, whatever harness they were written for.

## Quirks the adapters handle (found while building the e2e suite)

- **OpenCode** (both majors) takes its project directory from `$PWD`, not from the process cwd, so the run sets `PWD` explicitly. Denying a permission removes the tool from the model's tool list.
- **OpenCode 2**:
  - `run --standalone` connects the MCP servers but never offers their tools to the model, so the run goes through the background service;
  - the service connects MCP servers asynchronously, and a session only gets the tools of servers already connected when it is created. The adapter starts the service and waits until `opencode mcp list` shows every server connected;
  - the service is found through `$TMPDIR`, so the run gets its own `TMPDIR`. Otherwise a service started by another run, with another config, would be reused;
  - MCP tools are keyed by real directory (`/var` → `/private/var` on macOS), so every path the harness sees is a real path;
  - MCP tools are hidden behind Code Mode's `execute` unless the server sets `codemode: false`, which the adapter does;
  - the service is stopped when the run ends.
- **Codex** blocks MCP tool calls under `approval_policy = never` unless the server sets `default_tools_approval_mode = "approve"`. It emits transient `error` events ("Reconnecting… n/5") before the fatal `turn.failed`; only the latter counts as an error. It waits on stdin when stdin is open.
- **Pi** exits with code **0** on a provider error; the failure is in `message_end.stopReason = "error"`. An explicit `--tools` list drops MCP tools unless it includes `mcp__*`. MCP servers need `exposure: "direct"` to be visible to the model.
- **claw-code** speaks MCP with LSP-style `Content-Length` framing, not newline-delimited JSON; the `harness` MCP server auto-detects both. Its `read-only` mode refuses every MCP tool. Its generic `MCP` proxy tool does not see configured servers; deferred tools must be called by their qualified name. It writes `.claw/sessions/` into the workspace; those files are never committed.

## Versions

Pinned in [`src/harness/versions.json`](../src/harness/versions.json), bumped weekly by a workflow that opens a PR. The keyless e2e matrix validates each bump. Override per run with `harness_version` (an npm version, or for claw a commit SHA or the path of a prebuilt binary).
