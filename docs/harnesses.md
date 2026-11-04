# Harnesses

Each adapter translates the same portable settings (`model`, `tools`, `allow_bash`, MCP servers, skills) into the harness's native configuration, and normalises the harness's output into one execution log (`report/execution.jsonl`).

| | OpenCode (default) | Codex | Pi | OpenClaw |
|---|---|---|---|---|
| package | `@opencode/cli` (OpenCode 2) | `@openai/codex` | `@earendil-works/pi-coding-agent` | `openclaw` |
| command | `opencode run --format json --auto` (through its background service) | `codex exec --json -` (prompt on stdin) | `pi --mode json --session-dir …` | `openclaw agent --local --session-id <id> --json --message …` |
| config | `~/.config/opencode/opencode.json` in the isolated home (`providers`, ordered `permissions`, `mcp.servers`) | private `CODEX_HOME/config.toml` | private `PI_CODING_AGENT_DIR` | `~/.openclaw/openclaw.json` in the isolated home |
| `read-only` | `edit`/`shell`/`webfetch`/`websearch` denied | `sandbox_mode = read-only` | `--tools read,grep,find,ls,mcp__*` | `tools.deny`: write, edit, apply_patch, exec, process, web tools |
| `edit` | `edit` allowed, `shell` per `allow_bash` pattern | `workspace-write`, network off | `+ edit,write` (+ `bash` if `allow_bash`) | + write/edit tools (+ `exec` if `allow_bash`) |
| `full` | everything allowed (questions denied) | `danger-full-access` | `+ bash` | `tools.exec.mode: full` + web tools |
| skills | `~/.agents/skills` + the repo's `.opencode`/`.claude`/`.agents` | `~/.agents/skills` + repo `.agents/skills` | `~/.agents/skills` + repo `.agents`/`.pi` | `skills.load.extraDirs: [~/.agents/skills]` |
| MCP tool names | `harness_<tool>` | `harness.<tool>` (namespace) | `mcp__harness__<tool>` | `harness__<tool>` |
| resume (loop, conversation) | `-s <id>`; `session export` / `session import` | `exec resume <id>`; `CODEX_HOME/sessions` | `--session <id>`; the session dir | `--session-id <id>` (chosen by the action); `~/.openclaw/state` + `agents` |
| cost | per step | — | per message | per turn |

Skills committed to the repository in **any** of `.agents/`, `.claude/`, `.opencode/`, `.codex/`, `.pi/`, `.openclaw/skills` are copied to the isolated home, so every harness sees them, whatever harness they were written for.

## Quirks the adapters handle (found while building the e2e suite)

- **OpenCode** takes its project directory from `$PWD`, not from the process cwd, so the run sets `PWD` explicitly. Denying a permission removes the tool from the model's tool list. And:
  - `run --standalone` connects the MCP servers but never offers their tools to the model, so the run goes through the background service;
  - the service connects MCP servers asynchronously, and a session only gets the tools of servers already connected when it is created. The adapter starts the service and waits until `opencode mcp list` shows every server connected;
  - the service is found through `$TMPDIR`, so the run gets its own `TMPDIR`. Otherwise a service started by another run, with another config, would be reused;
  - MCP tools are keyed by real directory (`/var` → `/private/var` on macOS), so every path the harness sees is a real path;
  - MCP tools are hidden behind Code Mode's `execute` unless the server sets `codemode: false`, which the adapter does;
  - the service is stopped when the run ends.
- **Codex** blocks MCP tool calls under `approval_policy = never` unless the server sets `default_tools_approval_mode = "approve"`. It emits transient `error` events ("Reconnecting… n/5") before the fatal `turn.failed`; only the latter counts as an error. It waits on stdin when stdin is open.
- **Pi** exits with code **0** on a provider error; the failure is in `message_end.stopReason = "error"`. An explicit `--tools` list drops MCP tools unless it includes `mcp__*`. MCP servers need `exposure: "direct"` to be visible to the model.
- **OpenClaw**:
  - `agent exec` (its "headless" command) cannot resume a session, `agent --local --session-id` can. So the action picks the session id (a UUID) on the first turn and passes it again on every later turn;
  - MCP tools hide behind `tool_search` / `tool_describe` unless `tools.toolSearch: false`, which the adapter sets;
  - `tools.exec.mode` cannot be combined with `security` / `ask`; the config is rejected otherwise;
  - provider keys are referenced as `{ source: "env", provider: "env", id: "<VAR>" }` with a `secrets.providers.env` entry, so the key itself is never written to the config (which goes to the report artifact);
  - it prints one JSON document when the turn ends and exits 1 on failure, with the reason on stderr; `budget_usd` is checked after each turn.

## Versions

Pinned in [`src/harness/versions.json`](../src/harness/versions.json), bumped weekly by a workflow that opens a PR. The keyless e2e matrix validates each bump. Override per run with `harness_version` (an npm version).
