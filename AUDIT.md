# Code audit — November 2026

Scope: every file under `src/`, `action.yml`, `scripts/`, the tests and the workflows, read in full
twice (two independent passes). Baseline before any change: `npm run check` passed and `npm test`
passed 48/48. There is no linter and no build step.

## Summary

1. The code base is small (about 3,000 lines, zero dependencies), consistently written and well
   commented; the three-step design (prepare / run / publish) is sound and the adapters are clean.
2. Its weak point was the **publish step trusting what the agent leaves behind**: seven security
   defects let an agent with edit rights, a fork's workflow run or a third-party skills repository
   reach the token or redirect commits. All seven are fixed.
3. Nineteen logic bugs are fixed, the most visible being: every commit failing when
   `working_directory` is a sub-directory, work lost when the agent ran `git commit`, a crashed
   harness reported as success, and `loop_until` timeouts that did not stop anything. The
   nineteenth (OpenClaw's bootstrap files committed with the agent's changes) was found by running
   the release against the real GitHub API.
4. Three optimizations: no 440 MiB cache restore on skipped events, fewer and concurrent API
   calls in prepare, no parsing of the execution log unless it is displayed.
5. One limit is architectural and **not fixed**: an agent with an unsandboxed shell shares the
   runner and the user of the token-holding steps (see "Not fixed", critical).

Result: 29 fix / perf / chore / docs commits plus this report, 76 unit tests (48 before),
`npm run check` and `npm test` green on each commit. The full CI matrix (unit, end-to-end for the
four harnesses, `action.yml` smoke and conversation tests) was green on the branch before each push
to `main`, and on `main` after it. Released as v2.1.3, then v2.1.4 for B19.

## How to read the tests

Every fix has a test. The failing state was observed before the fix for A1, A6, A7, B1, B2, B3, B12
and B19 (a probe or a red test run, quoted in the commit message); for the others the test was
written together with the fix from the reading of the code. Repository fixtures in
`test/unit/git.test.mjs` build their commits with plumbing (`git commit-tree`), so no hook or
signing configuration is involved.

## Verified against the real GitHub API

After v2.1.3 was released, `e2e-github.yml` (the real API, the scripted mock model) was run on a
throwaway issue (#36) and pull request (#37), both closed afterwards:

| What | Harness | Observed |
|---|---|---|
| Prompt from the Actions tab → pull request | OpenCode | signed commit, pull request #38 opened with the reply |
| Mention on an issue | Pi | tracking comment, new branch, commit verified by GitHub |
| Second mention on that issue | Pi | conversation restored from the artifact (A3: a run of this repository is accepted), "Continuing on" its branch (the branch guard accepts it), session resumed; the earlier reply appears in the prompt as "you (harness, earlier reply)" (A5 with a real job token) |
| Mention on a pull request | Codex | head checked out, commit verified on the pull request branch, inline review comment placed on `E2E.md:1` (B7 on a real diff) |
| Second mention on that pull request | Codex | conversation restored and resumed |
| Mention on an issue | OpenClaw | green, but the commit held five files instead of one: **B19**, fixed |
| Comment without the trigger phrase | — | harness cache step skipped (C1): the job took 6 s, against 11 s and 34 s with a 440 MB restore on two runs before the change |
| Artifact metadata | — | `workflow_run.repository_id` and `head_repository_id` are present on real artifacts, as A3 relies on |
| Skills clone credentials | — | against github.com: no token clones, an invalid token is refused (so the header does reach GitHub), a valid one clones, and the error holds no token (A7) |

Still not exercised for real: a run with a real model (`e2e-live.yml`, needs provider secrets and
costs money); the refusal of an artifact uploaded by a fork's run (unit-tested on the mock; it
needs a fork to try); the branch continuation with `session_store: cache` (the resume itself is
covered by CI); the checkout of a pull request for a read-only question (B18, same git commands as
the push path, which is verified).

## Bugs fixed

### Security

| | Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| A1 | `5941be2` | `src/git.mjs`, `src/stages/publish.mjs` | The commit read each changed path with `readFileSync`, which follows symbolic links: an agent could point one at `/proc/self/environ` or the credentials file and have the token-holding step commit the target. A nested repository aborted the whole commit (EISDIR). | `lstat`; only regular files are sent. Links and nested repositories are reported in the log and the reply and stay in `changes.patch`. | `git.test.mjs`: "a symbolic link is never followed" |
| A2 | `bc2773b` | `src/skills.mjs` | The skill `name` from SKILL.md was joined to the skills folder, then deleted and overwritten: `name: ../../..` replaced any directory during prepare, the action's own sources included. | A name that is not a single path segment falls back to the directory name. | `core.test.mjs`: "a skill name cannot escape" |
| A3 | `5fbdd23` | `src/github/session-store.mjs`, `src/stages/prepare.mjs`, `src/stages/run.mjs` | A conversation is restored from the newest artifact of its name, and any run can upload one, a fork's pull request included. Its `meta.json` chose the branch of the next commit (`main` worked) and the session id put on the harness command line. | Only artifacts from a run of this repository; the branch must be one the action creates (not the default branch, not `base_branch`, inside `branch_prefix` unless a template is set); the session id must look like one; a pull request whose head is the default branch gets a patch, not a push. | `conversation.test.mjs`: "restored from the newest artifact", "cannot redirect the next commit" |
| A4 | `ba4394f` | `src/stages/prepare.mjs` | The generated harness configuration is copied into the report artifact (public on a public repository) with the `headers` / `env` values of `mcp_config`: the bearer tokens of the `docs/recipes.md` example. | Those values are replaced by `***` in the report copy only. | `harness.test.mjs`: "MCP header and env values are redacted" |
| A5 | `6f1d5f7` | `src/stages/prepare.mjs` | Any comment containing the hidden tracking marker was shown to the model as its own earlier reply and skipped the author filters; any comment with the sticky marker was adopted and overwritten. | Markers count only on comments written by the token's identity (`GET /user` for a personal token, otherwise a bot author). | `conversation.test.mjs`: "the hidden markers only count" |
| A6 | `8b7c7c9` | `src/git.mjs`, `src/stages/publish.mjs` | Publish ran `git add` / `git diff` with the repository configuration the agent could edit: `core.fsmonitor`, a `post-index-change` hook, a clean filter or `diff.external` executed a command in the token-holding step, just after the credentials were restored. | Those calls disable hooks, the fsmonitor, every configured filter driver and external diff programs, and get the scrubbed environment; credentials are restored after them. | `git.test.mjs`: "git configuration written by the agent runs nothing" |
| A7 | `9f46353` | `src/skills.mjs` | The skills token was on the `git` command line; a failed clone put `AUTHORIZATION: basic <base64 token>` in the error, hence in the log (the mask only covers the raw token) and in the public tracking comment. | The header goes through git's environment (`GIT_CONFIG_*`); the error carries git's stderr only. | `core.test.mjs`: "a failed skills clone does not put the token in its error" |

### Logic

| | Commit | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| B1 | `ef8a5ad` | `src/git.mjs`, `publish.mjs` | `git status` paths are relative to the repository root but files were read from `working_directory`: with a sub-directory every commit failed (ENOENT) and the patch missed the rest of the repository. | Everything is resolved from `git rev-parse --show-toplevel`; harness state directories are ignored at any depth. | `git.test.mjs`: "working_directory in a sub-directory" |
| B2 | `c4e091d` | `src/stages/run.mjs` | The `loop_until` timeout killed the shell only; its children kept the pipes open, so the step waited for them (kill at 0.3 s, return at 6 s) and they ran on into the next iteration. | The check runs in its own process group, killed as a whole. | `conversation.test.mjs`: "the completion check timeout stops everything" |
| B3 | `8662538` | `src/runner.mjs`, `src/harness/exec.mjs` | No `error` listener on the child's stdin: Codex exiting before it read a prompt larger than the pipe buffer crashed the run step (`write EPIPE`), and publish could only say the harness did not run. | The stream error is handled; the run ends as an error with the exit code and stderr. | `harness.test.mjs`: "exits without reading its stdin" |
| B4 | `44cd3f5` | `src/stages/run.mjs` | The 128 KiB command-line limit was checked in UTF-16 units, and not at all for the prompt of a resumed conversation: a long non-Latin request failed with E2BIG. | One helper, counting bytes, for both. | `conversation.test.mjs`: "too large for one command-line argument" |
| B5 | `3c91be5` | `publish.mjs` | On a detached checkout the branch is the literal `HEAD`, used as the base of the Create-PR link and of `open_pr` (422). | Falls back to the default branch. | `git.test.mjs`: "a detached checkout" |
| B6 | `cafb7e4` | `publish.mjs` | `execution.jsonl` was parsed, unguarded, on every run: one line cut short by a cancelled run threw after the commit and before the outputs. | Read only for `display_report`, bad lines skipped. | `publish.test.mjs`: "a truncated execution log" |
| B7 | `4080979` | `src/git.mjs`, `publish.mjs` | An added line starting with `++ ` reads `+++ …` in a diff and was taken for a file header; a comment on `./a.js` never matched `a.js`. | Hunks are read by the line counts of their header; `./` is stripped. | `core.test.mjs`: "diff parsing" |
| B8 | `d6bd5bb` | `src/contract.mjs` | `validate` threw on an invalid `pattern`; a finding with `end_line: null` and no line got `endLine: 0`. | A validation error; no end line without a line. | `core.test.mjs`: "json schema validation", "an end line needs a start line" |
| B9 | `2968e1c` | `prepare.mjs`, `src/publish/render.mjs` | The footer of an earlier reply was stripped from the first `<sub>` line to the end; `\|` in a finding title broke the table. | Last line only; the title is escaped. | `conversation.test.mjs`: "earlier replies", "a finding title" |
| B10 | `ebd5412` | `src/mcp/server.mjs` | `submit_structured_output` answered "recorded" for anything; an invalid result failed the run at publish with no chance to correct. | The tool validates and returns the errors; nothing is recorded until valid. | `core.test.mjs`: "an invalid structured output is refused" |
| B11 | `964bbf9` | `src/runner.mjs`, `src/harness/openclaw.mjs`, `prepare.mjs`, `src/github/api.mjs` | A parser that throws left the run promise pending for ever; a refused pull request diff was swallowed; a dropped connection on a read failed the step. | Error event; warning; reads are retried (writes are not). | `harness.test.mjs`: "openclaw: output that is JSON", "a dropped connection" |
| B12 | `3b3f51e` | `src/runner.mjs` | A non-zero exit is forgiven after a "finished turn", which only meant some text with no error after it: a remark, tool calls, then a crash (OOM, SIGKILL) was a success and the half-edited tree was committed. | The message must be the last thing the agent did; a signal exit never counts. | `harness.test.mjs`: "exit 1 after a finished turn" |
| B13 | `f7f8453` | `src/git.mjs`, `publish.mjs` | Changes were computed against the current HEAD: an agent that ran `git commit` left a clean tree and its work was silently dropped. | Computed against the commit the run started from, through one scratch index. | `git.test.mjs`: "work the agent committed locally" |
| B14 | `8e77a78` | `src/cli.mjs`, `action.yml`, `prepare.mjs` | `session_store: cache`: the cache was restored after prepare had looked for the conversation's branch, so an issue conversation never continued on its branch. | `resolve` names the conversation; the restore step runs before prepare. | `core.test.mjs`: "resolve names the cached conversation"; CI `action-conversation` (cache) |
| B15 | `f192220` | `src/harness/codex.mjs`, `src/inputs.mjs` | TOML `harness_config` was appended after the generated `[projects."…"]` table: its top-level keys were read as keys of that table and ignored; a `.toml` path was appended as literal text. | Top-level keys go before the first generated table and win over a generated key; `.toml` paths are read. | `harness.test.mjs`: "codex: TOML harness_config" |
| B16 | `3c91be5` | `publish.mjs` | Branch names are unique to the minute: a second run in the same minute got "Reference already exists" and lost its commit. | One retry with a short random suffix. | `git.test.mjs`: "a branch name that is already taken" |
| B17 | `4e49d78` | `src/inputs.mjs`, `publish.mjs` | Publish read `json_schema` / `mcp_config` / `harness_config` paths again after the agent ran: a schema rewritten to `{}` validated anything, a corrupted file threw before credentials were restored. | Publish uses the schema parsed by prepare and reads none of them. | `publish.test.mjs`: "checked against the schema prepare parsed" |
| B18 | `4c7ce55` | `prepare.mjs`, `src/prompt.mjs` | A question asked in a comment on a pull request ran on the default branch while the prompt said it was on the pull request branch. | A same-repository pull request is checked out (best effort); when the files are not the pull request's, the prompt says so. | `conversation.test.mjs`: "a question on a pull request" |
| B19 | `d559b50` | `src/harness/openclaw.mjs` | OpenClaw seeds its workspace, which is the repository checkout, with `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md`; they were committed with the agent's changes. Older than this audit; the mock end-to-end suite only checked that the expected file was in the commit. | `agents.defaults.skipBootstrap: true` (`harness_config` can turn it back on). | `harness.test.mjs`: "openclaw config"; `test/e2e/run.mjs`: "only the files the agent changed are committed", for every harness |

## Optimizations

| | Commit | Change | Gain |
|---|---|---|---|
| C1 | `52a0003` | The mode is detected in `resolve` (no API call needed); the harness cache step is skipped for an event that will be skipped. | **Measured** on the last CI run of `main`: the restore it avoids is 439.9 MiB / 4.2 s for OpenCode, 160 MiB / 5.5 s for OpenClaw, 151 MiB / 2.7 s for Codex, 20 MiB / 1.1 s for Pi. It was paid on every comment in a workflow without a job-level `if` (the README quick start). |
| C2 | `2288744` | Issue comments are listed once per run; the pull request, its review comments, its diff and its files are fetched concurrently. | **By construction:** on a pull request with a sticky comment, 6 sequential round trips become 3, and one request per 100 comments is saved. **Estimated** 0.3 to 1 s per run at usual API latency; not measured against the real API. |
| C3 | `cafb7e4` | The execution log is no longer read and parsed unless `display_report` is on. | **Measured** on a synthetic 38.5 MiB log (5,000 events): about 60 ms and 70 MiB of memory per run. |

## Behaviour changes to know about

None changes an input or an output of the action. These change what a run does:

- **A1:** symbolic links and nested repositories are no longer committed (they never could be
  committed correctly); they are listed in the reply.
- **A3:** a conversation saved by a run whose code came from a fork is ignored, and a saved branch
  outside `branch_prefix` starts a new branch. A pull request whose head is the default branch is
  no longer pushed to.
- **A4:** `report/config/*` shows `"***"` for MCP header and env values.
- **A5:** with a personal token and `use_sticky_comment`, only that user's comment is reused; with
  a job or app token, only a bot's.
- **A6:** `changes.patch` is produced without the repository's filter drivers (an LFS file shows
  its content, not its pointer).
- **B10:** agent-facing: `submit_structured_output` can now answer with an error.
- **B12:** a run that crashed after its last message used to be `success` in some cases; it is
  `error` now.
- **B13:** commits made by the agent itself are folded into the action's signed commit.
- **B16:** a branch can end with a `-xxxx` suffix when its name was taken.
- **B18:** a read-only run on a same-repository pull request now sees the pull request's files.
- **B19:** OpenClaw no longer writes its bootstrap files into the checkout
  (`harness_config: {"agents":{"defaults":{"skipBootstrap":false}}}` brings them back).

## Not fixed

### Critical

- **The token boundary does not hold against an agent with an unsandboxed shell.** Prepare, Run and
  Publish share one runner and one user. With `tools: full`, or `allow_bash` on Pi and OpenClaw
  (which enable the whole shell), a steered agent can rewrite the action's own files under
  `$GITHUB_ACTION_PATH`, edit `context.json` (commit target, credential paths), or leave a
  background process that reads the credentials Publish restores. The fixes above close the paths
  open to an *edit-only* agent; this one needs a change of architecture.
  **Recommendation:** run Publish in a separate job (state passed as an artifact, validated), or
  run the agent in a sandbox (container, another UID); until then, state the limit in
  `docs/security.md`, whose headline claim reads as unconditional.

### Important

- **Submodule credentials** (`actions/checkout` v5 and older, `submodules: true`): the extraheader
  in `.git/modules/*/config` is not stripped. Recommendation: strip with
  `git submodule foreach --recursive`, or document checkout v6+ as required.
- **`get_pr_diff` returns up to 2 MB in one tool result**, more than most context windows.
  Recommendation: an optional `path` argument and a size cap with a "use `path`" hint.
- **The GraphQL commit has no retry** while REST calls have one. `expectedHeadOid` makes a retry
  safe to reason about; a 502 currently loses the commit.
- **API limits of `createCommitOnBranch`:** a new file loses its executable bit, an LFS file is
  committed as a full blob, links cannot be committed. Recommendation: document; for the first
  two, detect and warn.
- **Threads over 500 comments keep the oldest**, not the newest, and the sticky comment may not be
  found beyond that. Recommendation: page from the end.
- **Static input errors surface late** (unknown `skill`, a model without provider): after the
  tracking comment and the harness install. Recommendation: validate before the first API call.

### Minor

- `allow_bash` and `skills` are split on commas as well as new lines (a pattern containing a comma
  is cut in two).
- Edits under `.openclaw/skills` are excluded from commits with the rest of `.openclaw/`.
- The JSON-schema validator ignores `$ref`, `format` and `exclusiveMinimum` silently.
- With `display_report` a long transcript can exceed the 1 MiB job-summary limit.
- `finalBody` truncates the whole comment at 64,000 characters, which can cut the footer or leave a
  `<details>` open; truncating the agent's text instead would keep the frame.
- No timeout on `fetch`; a hung connection lasts until the job timeout.
- The harness versions are pinned but their transitive npm dependencies are not.
- A skill source ref of 7 to 39 hex characters is fetched as a commit, which GitHub refuses.
- `owner/repo` is always read as a GitHub repository, even when a directory of that name exists.
- `package.json` says 2.1.1 while the latest tag is v2.1.2 (the release workflow does not bump it).
- With `show_full_output`, harness stderr is printed raw: a line starting with `::` would be read
  as a workflow command.
- The non-resumable branch of `feedbackPrompt` is unreachable (every adapter resumes); kept, as it
  documents the contract for a future adapter.

## Open questions

1. **A failed commit leaves `conclusion: success`** and a green job, even with
   `on_agent_error: fail`. The changes were not pushed. Should it count as a failure?
2. **A loop without `loop_until` that never calls `task_complete`** ends as success after
   `max_iterations`. Intended?
3. **When the time budget is spent**, a new loop iteration still starts with 0.5 minute. Stop the
   loop instead?
4. **`edited` events:** access is checked on the person who edited, not on the author of the text
   that is run. A maintainer fixing a typo in a stranger's issue that says `@harness do …` runs
   it with edit rights (if the workflow listens to `edited`; the README sample does not). Check the
   author too?
5. **Label and assignee triggers** are classified from the issue title, so most become read-only
   answers ("Login page crashes" has no action verb). Should a label mean "do"?
6. **A question on a fork's pull request** still runs on the default branch (B18 only checks out
   same-repository heads, because a fork's code would sit next to the provider keys). Check it out
   read-only anyway, or keep it this way?
7. **`docs/security.md`:** should it state the shell-capable-agent limit explicitly?

## Checked and found correct

Spawn failures still emit `close`; the artifact download drops the `Authorization` header on the
redirect; zip-slip is blocked by `unzip` and by `zipfile`; `GITHUB_OUTPUT` uses a random delimiter
and annotations are escaped; agent text in the log is always prefixed, so it cannot start a
workflow command; `plan.json` holds no token; the access check runs before any write; GraphQL
errors returned with HTTP 200 are detected; `git fetch` / `checkout -B` cannot be option-injected
by a branch name.
