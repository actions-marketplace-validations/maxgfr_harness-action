# Security model

An agent in CI reads text written by strangers (issues, PR bodies, comments, code) and can be steered by it (prompt injection). harness-action assumes the agent **can** be steered, and limits what a steered agent can reach.

## The GitHub token never reaches the agent

The action is three steps:

| step | GitHub token | what it does |
|---|---|---|
| **Prepare** | yes | mode detection, access check, tracking comment, fetches the thread / diff / CI status to files, installs the harness and skills, writes a **token-free** `plan.json` |
| **Run** | **no** | runs the harness from `plan.json`; its environment is scrubbed (`GITHUB_TOKEN`, `GH_TOKEN`, `INPUT_*`, `ACTIONS_*` runtime tokens, `GITHUB_OUTPUT`/`ENV`/`PATH`/`STEP_SUMMARY`) |
| **Publish** | yes | replays the agent's outbox (progress, findings, inline comments), commits the working tree, updates the comment, writes reports, gates |

On top of that:

- **Persisted checkout credentials are removed for the run.** This covers the extraheader in `.git/config` and the credentials file `actions/checkout` v6+ keeps under `$RUNNER_TEMP`. They are recreated in Publish with `github_token`.
- **The agent cannot push.** It edits files; the action commits them with `createCommitOnBranch` (signed by GitHub) to the branch it chose (`commit_mode`), never to the default branch. Changes to `.github/workflows/` are left out of the commit with the job token, which GitHub never lets change workflows: they stay in `changes.patch` and the reply lists them. Only a GitHub App token with the *workflows* permission, passed as `github_token`, can commit them; think twice before granting it, since a workflow runs with the repository's secrets.
- **The MCP server holds no token.** Write tools append to an outbox file; read tools serve files fetched in Prepare.
- **Install scripts get no token.** `npm install` of the harness runs with the same scrubbed environment.
- The run uses an **isolated `$HOME`**, so the harness does not see the runner's `~/.gitconfig`, `~/.npmrc`, `~/.docker`, etc.

## What the agent can still reach

- **Your provider API key.** The harness needs it to call the model. With `tools: full` (shell and network), a steered agent could send it somewhere. Use a key with a spending limit, and prefer `read-only` / `edit` with an `allow_bash` list.
- **The workspace and the runner filesystem**, read-only or not, depending on the harness. Do not put secrets on disk before the action runs.
- **Network access**, depending on the harness and the level: OpenCode `webfetch` and the Codex sandbox network are off below `full`. A shell command can still reach the network when bash is allowed.

## Conversations (the session cache)

With `session` on (the default in tag mode), the harness session is saved as a workflow artifact named `harness-session-v1-<harness>-<issue|pr>-<n>`, or with the Actions cache when `session_store: cache`. It holds the transcript: prompts, replies, and the tool calls and outputs the agent made. That is the same content as the `execution.jsonl` of the report artifact.

Who can read it:
- the artifacts of a **public** repository can be downloaded by anyone with read access;
- the caches of the default branch can be restored by any workflow of the repository.

So treat a conversation as being as public as the repository. In particular, don't let the agent print secrets in a session you resume. Use `session: off` if your conversations can hold sensitive data. Saved conversations expire after `session_retention_days`.

The restored session is read by the run step only, which has no token. The agent cannot write a saved conversation itself: saving happens in a later step, and the runtime token is stripped from its environment.

## Who can trigger it

In tag mode, and for comment events, the actor must have **write** access to the repository. Bots are refused unless listed in `allowed_bots`. `allowed_non_write_users` opens the agent to anyone you list (`*` = everyone): only do that with `tools: read-only` and no `commit_mode`.

## Recommendations

- Grant the job only the permissions it needs (`contents: read` for a read-only review).
- Avoid `pull_request_target` with a checkout of the PR head. Fork PRs get no secrets on `pull_request`, which is the safe default.
- `display_report` and `show_full_output` print what the agent saw and did, possibly including injected content: only for trusted repositories.
- Set `timeout_minutes`, `max_steps` and, where the harness reports cost, `budget_usd`.
