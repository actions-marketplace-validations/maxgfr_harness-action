# Harnesses

Each adapter translates the same portable settings (`model`, `tools`, `allow_bash`, MCP servers, skills) into the harness's native configuration, and normalises the harness's event stream into one execution log (`report/execution.jsonl`).

| | OpenCode | Codex | Pi | claw-code |
|---|---|---|---|---|
| command | `opencode run --format json` | `codex exec --json -` (prompt on stdin) | `pi --mode json --no-session` | `claw --output-format json prompt --stdin` |
| config | `OPENCODE_CONFIG_CONTENT` (merged on the repo's) | private `CODEX_HOME/config.toml` | private `PI_CODING_AGENT_DIR` | `~/.claw.json` in the isolated home |
| `read-only` | `edit`/`bash`/`webfetch` denied | `sandbox_mode = read-only` | `--tools read,grep,find,ls,mcp__*` | `workspace-write` + `--allowedTools` read tools + harness MCP tools |
| `edit` | `edit` allowed, bash per `allow_bash` pattern | `workspace-write`, network off | `+ edit,write` (+ `bash` if `allow_bash`) | `workspace-write` |
| `full` | everything allowed | `danger-full-access` | `+ bash` | `danger-full-access` |
| skills | `~/.agents/skills` + the repo's `.opencode`/`.claude`/`.agents` | `~/.agents/skills` + repo `.agents/skills` | `~/.agents/skills` + repo `.agents`/`.pi` | `~/.claw/skills` + repo `.claw`/`.agents`/`.claude` |
| MCP tool names | `harness_<tool>` | `harness.<tool>` (namespace) | `mcp__harness__<tool>` | `mcp__harness__<tool>` (deferred) |
| cost | per step | — | per message | estimate at the end |

Skills committed to the repository in **any** of `.agents/`, `.claude/`, `.opencode/`, `.claw/`, `.codex/`, `.pi/skills` are copied to the isolated home, so every harness sees them, whatever harness they were written for.

## Quirks the adapters handle (found while building the e2e suite)

- **OpenCode** takes its project directory from `$PWD`, not from the process cwd, so the run sets `PWD` explicitly. Denying a permission removes the tool from the model's tool list.
- **Codex** blocks MCP tool calls under `approval_policy = never` unless the server sets `default_tools_approval_mode = "approve"`. It emits transient `error` events ("Reconnecting… n/5") before the fatal `turn.failed`; only the latter counts as an error. It waits on stdin when stdin is open.
- **Pi** exits with code **0** on a provider error; the failure is in `message_end.stopReason = "error"`. An explicit `--tools` list drops MCP tools unless it includes `mcp__*`. MCP servers need `exposure: "direct"` to be visible to the model.
- **claw-code** speaks MCP with LSP-style `Content-Length` framing, not newline-delimited JSON; the `harness` MCP server auto-detects both. Its `read-only` mode refuses every MCP tool. Its generic `MCP` proxy tool does not see configured servers; deferred tools must be called by their qualified name. It writes `.claw/sessions/` into the workspace; those files are never committed.

## Versions

Pinned in [`src/harness/versions.json`](../src/harness/versions.json), bumped weekly by a workflow that opens a PR. The keyless e2e matrix validates each bump. Override per run with `harness_version` (an npm version, or for claw a commit SHA or the path of a prebuilt binary).
