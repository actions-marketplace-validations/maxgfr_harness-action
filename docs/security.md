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

- **The agent runs as its own user** whenever it can run code (see below).
- **Persisted checkout credentials are removed for the run.** This covers the extraheader in `.git/config` and in the configuration of every submodule, and the credentials file `actions/checkout` v6+ keeps under `$RUNNER_TEMP`. They are recreated in Publish with `github_token`, after the agent's processes are gone, and never through a symbolic link.
- **The agent cannot push.** It edits files; the action commits them with `createCommitOnBranch` (signed by GitHub) to the branch it chose (`commit_mode`), never to the default branch. Changes to `.github/workflows/` are left out of the commit with the job token, which GitHub never lets change workflows: they stay in `changes.patch` and the reply lists them. Only a GitHub App token with the *workflows* permission, passed as `github_token`, can commit them; think twice before granting it, since a workflow runs with the repository's secrets.
- **Publish does not trust the working tree.** Only regular files are committed: a symbolic link is never followed (it is listed in the reply and kept in `changes.patch`). The git commands Publish runs there ignore the repository's hooks, `core.fsmonitor`, filter drivers and external diff programs, and the checkout credentials come back only after them. `json_schema` given as a file is the one read before the run.
- **The MCP server holds no token.** Write tools append to an outbox file; read tools serve files fetched in Prepare.
- **Install scripts get no token.** The harness is installed with the same scrubbed environment, with `npm ci` from a lockfile shipped with each release (`src/harness/locks`): every package it depends on is pinned with its integrity hash. A `harness_version` other than the pinned one is resolved at install time instead.
- The run uses an **isolated `$HOME`**, so the harness does not see the runner's `~/.gitconfig`, `~/.npmrc`, `~/.docker`, etc.

## The agent's own user

Scrubbing the environment keeps the token out of the agent's reach only if the agent cannot reach the steps that hold it. Without more, the three steps run as the same user, so code the agent runs (a shell command, or the `loop_until` check, which executes what the agent wrote) could rewrite the action's files or the state Publish reads, read the environment of the token-holding steps through `/proc`, or leave a process behind that waits for Publish to restore the credentials.

So with `sandbox: auto` (the default), whenever the agent can run code (`tools: full`, an `allow_bash` list, or `loop_until`) and the runner allows it, the whole Run step (harness, MCP server, completion check) runs as a system user created for this run only (`ha-agent-<random>`), deleted by Publish:

- it can write the working tree, its own home and the directories the Run step writes to, nothing else of the runner's;
- the files Prepare wrote (`plan.json`, `context.json`, the prompts) are the runner's, in a sticky directory: the agent can read them but not replace them;
- it cannot read the environment of the runner's processes, nor write the action's files;
- every one of its processes is killed at the end of the Run step, and again before Publish restores credentials (which it does not do if one survives), and its cron jobs are removed;
- its files become the runner's again, the modes of the working tree are put back, symbolic links are removed from the directories Publish reads or uploads, and the checkout's git configuration and hooks are restored as they were before the run;
- Publish compares the working tree through a git directory of its own and uses the checkout root recorded by Prepare: nothing the agent writes into `.git` is read by a step that holds the token, nor by a later use of the action in the same job.

This needs Linux and passwordless `sudo`, which GitHub-hosted runners have; the action creates the user, makes the directories above the workspace traversable (`o+x`), and makes the workspace writable for it. On a runner that cannot (macOS, Windows, a container already running as root, no `sudo`), `auto` warns and runs the agent as the job's user; `sandbox: on` fails instead, and `sandbox: off` never isolates. As the agent's user, a command cannot use what belongs to the job's user: the Docker socket, `sudo`, and anything it would write under the job's `$HOME`. Its `HOME` and its temp directory (`TMPDIR`, `TEMP`, `TMP`) are its own, in the action's state directory: `$RUNNER_TEMP` is readable but not writable for it. Its `HOME` being its own, so tools that keep their caches or toolchains in the runner's home (`~/.cargo`, `~/.m2`, `pip --user`) cannot write there: fetch dependencies before the action (`cargo fetch`, `mvn dependency:go-offline`, `npm ci`), point those tools at a directory in the workspace, or set `sandbox: off` if the agent's commands need the job's user.

When the action is used from the workspace itself (`uses: ./`), its files are part of the working tree the agent may write: use a published version (`owner/harness-action@v2`) for the isolation to cover them.

## What the agent can still reach

- **Your provider API key.** The harness needs it to call the model. With `tools: full` (shell and network), a steered agent could send it somewhere. Use a key with a spending limit, and prefer `read-only` / `edit` with an `allow_bash` list.
- **The workspace and whatever else on the runner is world-readable.** Do not put secrets on disk before the action runs.
- **Network access**, depending on the harness and the level: OpenCode `webfetch` and the Codex sandbox network are off below `full`. A shell command can still reach the network when bash is allowed.

## Conversations (the session cache)

With `session` on (the default in tag mode), the harness session is saved as a workflow artifact named `harness-session-v1-<harness>-<issue|pr>-<n>`, or with the Actions cache when `session_store: cache`. It holds the transcript: prompts, replies, and the tool calls and outputs the agent made. That is the same content as the `execution.jsonl` of the report artifact.

Who can read it:
- the artifacts of a **public** repository can be downloaded by anyone with read access;
- the caches of the default branch can be restored by any workflow of the repository.

So treat a conversation as being as public as the repository. In particular, don't let the agent print secrets in a session you resume. Use `session: off` if your conversations can hold sensitive data. Saved conversations expire after `session_retention_days`.

A conversation is only restored from an artifact uploaded by a workflow run of this repository, never by the run of a fork's pull request. The branch it names must be one the action creates (inside `branch_prefix`, never the default branch or `base_branch`); otherwise a new branch is started.

The report artifact holds the generated harness configuration; the `headers` and `env` values of `mcp_config` are redacted in it. Values you put in `harness_config` are not: keep secrets out of it.

The restored session is read by the run step only, which has no token. The agent cannot write a saved conversation itself: saving happens in a later step, and the runtime token is stripped from its environment.

## Who can trigger it

In tag mode, and for comment events, the actor must have **write** access to the repository. Bots are refused unless listed in `allowed_bots`. The action's hidden comment markers only count on comments written by its own token: pasting one into a comment does not make it the agent's earlier reply. On an `edited` event, the author of the edited text must pass the same check as the person who edited it: a maintainer fixing a typo in a stranger's request does not run it with the maintainer's rights. `allowed_non_write_users` opens the agent to anyone you list (`*` = everyone): only do that with `tools: read-only` and no `commit_mode`.

A question asked in a comment on a pull request from a fork is answered from the base branch and the pull request's diff: the fork's code is not checked out next to the provider keys. A pull request from the same repository is checked out.

## Recommendations

- Grant the job only the permissions it needs (`contents: read` for a read-only review).
- Avoid `pull_request_target` with a checkout of the PR head. Fork PRs get no secrets on `pull_request`, which is the safe default.
- `display_report` and `show_full_output` print what the agent saw and did, possibly including injected content: only for trusted repositories.
- Set `timeout_minutes`, `max_steps` and, where the harness reports cost, `budget_usd`.
