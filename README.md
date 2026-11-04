# harness-action

**Run a real coding-agent harness in GitHub Actions — any model, any Agent Skill.**

`harness-action` drives an open-source agent harness — **[OpenCode](https://opencode.ai)** (2.x), **[Codex](https://github.com/openai/codex)**, **[Pi](https://pi.dev)** or **[OpenClaw](https://openclaw.ai)** — inside your workflow, with the model and provider you choose, and the [Agent Skills](https://agentskills.io) (`SKILL.md`) you point it at. It does what you expect from an agent action — `@mention` it on an issue or a PR, it replies, tracks its progress, pushes **signed** commits, posts reviews, and reports results — without being tied to one vendor's model.

And you can **talk to it like you talk to your local coding agent**: ask it a question and it **answers with recommendations** without touching the code; ask it to do something and it does it; every mention in the same thread continues the **same session** (it remembers what it did, and keeps working on the same branch), it can **loop until your tests pass**, and a prompt typed in the Actions tab (or `gh workflow run`) comes back as a **pull request** you keep chatting with.

```yaml
- uses: maxgfr/harness-action@v2
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  with:
    harness: opencode                     # opencode | codex | pi | openclaw
    model: openrouter/qwen/qwen3-coder    # provider/model
    skills: your-org/your-skills          # any repo with SKILL.md files
```

## Why

- **Any model.** Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Gemini, Ollama, or any OpenAI-compatible endpoint (`base_url`).
- **Any harness.** Pick the agent loop that suits the model: OpenCode (default), Codex, Pi or OpenClaw.
- **Any skill.** Install skills from any repository (`owner/repo@ref#skill`), or use the ones committed in yours (`.agents/`, `.claude/`, `.opencode/`, `.codex/`, `.pi/`, `.openclaw/skills`). Each harness gets them at its own discovery path.
- **The token never reaches the agent.** The run happens in a step that has no GitHub token. Persisted checkout credentials are removed for that step. Comments, reviews and commits are replayed afterwards by deterministic code (see [Security](docs/security.md)).
- **One output contract.** Every harness reports the same way: findings become annotations, SARIF and a gate (`fail_on`); `json_schema` gives a validated `structured_output`; plus a job summary, a sticky comment and a report artifact.

## Quick start

### 1. `@harness` on issues and pull requests

```yaml
# .github/workflows/harness.yml
name: harness
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
  issues: { types: [opened, assigned, labeled] }

jobs:
  harness:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # push branches / commits
      pull-requests: write   # reviews, PR comments
      issues: write          # issue comments
      actions: read          # find the saved conversation (session)
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v2
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-5-5
          allow_bash: |
            npm test*
            npm run lint*
```

Comment `@harness fix the flaky date test` on an issue. The agent replies in a tracking comment and updates its checklist as it goes. Its changes land on a new `harness/issue-N-…` branch as a **Verified** commit, and the reply ends with a *Create PR* link. The next mention on that issue continues on the same branch. On a pull request, it pushes to the PR branch and can leave line-level review comments.

**Questions get answers, requests get changes** (`ask_mode: auto`): `@harness why is the build slow?` is answered read-only, with ranked recommendations and file references, and no branch or commit. `@harness fix …`, `add …`, `implement …`, `corrige …`, `ajoute …` (a request that starts with an action verb) changes the code. `@harness ask …` and `@harness do …` force either one; `ask_mode: always` only answers, `off` lets every mention change code.

### 2. Review every pull request with a skill

```yaml
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: write, security-events: write }
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v2
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          harness: codex
          model: openai/gpt-5.1-codex
          skills: your-org/review-skills#security-review
          skill: security-review
          prompt: Review the changes of this pull request. Report every problem with report_finding and comment inline on the diff.
          post_comment: true
          fail_on: error
          sarif: true
```

### 3. A scheduled audit that returns structured data

```yaml
on: { schedule: [{ cron: '0 6 * * 1' }] }
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: audit
        uses: maxgfr/harness-action@v2
        env: { OPENROUTER_API_KEY: '${{ secrets.OPENROUTER_API_KEY }}' }
        with:
          harness: pi
          model: openrouter/deepseek/deepseek-chat-v3.1
          skills: your-org/audit-skills
          prompt: Audit the repository and summarise the risks.
          json_schema: '{"type":"object","required":["risk"],"properties":{"risk":{"enum":["low","medium","high"]},"notes":{"type":"string"}}}'
      - run: echo '${{ steps.audit.outputs.structured_output }}' | jq .
```

More in [docs/recipes.md](docs/recipes.md).

## Talk to it like your local agent

### A conversation per issue / pull request

`session: auto` is the default: each `@harness` mention on the same issue or PR **resumes the same harness session**, with its full memory of earlier turns, files read and tool results. The session is saved as a workflow artifact, one per harness and thread, and restored on the next mention. The job needs `actions: read` to find it. A resumed session gets a short follow-up prompt instead of the whole setup again.

> Why artifacts and not the Actions cache: since June 2026 the cache is [read-only for `issue_comment`](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers/) and the other low-trust triggers, which are exactly the triggers of a conversation. `session_store: cache` is still available for trusted triggers, or for jobs that set `cache-mode: write`.

```text
@harness what would you change in the retry logic?   → answer + recommendations, no change
@harness do the second option                         → same session: branch + signed commit
@harness also document it in the README               → same session, same branch
```

Every harness resumes natively: OpenCode (`session export` / `import`), Codex (`exec resume`), Pi (`--session`), OpenClaw (`agent --local --session-id`). Earlier replies are also part of the context. `session: off` starts fresh each time. `session_key` names a conversation explicitly.

### Loop until it is done

```yaml
with:
  loop_until: npm test        # "done" means this command succeeds
  max_iterations: '5'         # default 5 with loop_until
```

After each turn, the action runs `loop_until`. If it fails, the agent is re-prompted **in the same session** with the command's output, until it passes or `max_iterations` is reached. The run fails if it never passes, subject to `on_agent_error`. Without `loop_until`, `max_iterations: N` keeps the agent going until it calls the `task_complete` tool. `max_steps`, `timeout_minutes` and `budget_usd` cover the whole loop.

### A prompt that comes back as a pull request

```yaml
on:
  workflow_dispatch:
    inputs:
      prompt: { description: 'What should the agent do?', required: true }
jobs:
  agent:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write, issues: write }
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v2
        env: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' }
        with:
          model: anthropic/claude-sonnet-5-5
          prompt: ${{ inputs.prompt }}
          tools: edit
          open_pr: true          # new branch + pull request, the reply as its description
          loop_until: npm test
```

```bash
gh workflow run agent.yml -f prompt="Add rate limiting to the /login route"
```

The pull request carries the conversation: mention `@harness` on it (with the tag-mode workflow above) and the same session continues. This repository dogfoods all of it in [`.github/workflows/harness.yml`](.github/workflows/harness.yml).

> With the job token (`github.token`), GitHub only lets a workflow open pull requests if the repository allows it: **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**, or `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=read`. A GitHub App token as `github_token` doesn't need it. Without either, the changes still land on the branch and the summary links to *Create PR*.

## Harnesses

| | OpenCode | Codex | Pi | OpenClaw |
|---|---|---|---|---|
| Status | **default** | stable | stable | stable |
| Install | npm `@opencode/cli` (OpenCode 2) | npm `@openai/codex` | npm `@earendil-works/pi-coding-agent` | npm `openclaw` (Node ≥ 24.16) |
| Providers | ~75 built in + any OpenAI/Anthropic-compatible | OpenAI + any OpenAI-compatible (Responses API) | ~15 built in + any compatible | built-in providers + any OpenAI/Anthropic-compatible |
| `allow_bash` patterns | ✅ enforced per pattern | sandboxed shell instead | bash all-or-nothing | shell all-or-nothing |
| Cost reported (`budget_usd`) | ✅ | ❌ (step / time limits only) | ✅ | ✅ (checked after each turn) |
| Resumes a session (conversation, loop) | ✅ export / import | ✅ `exec resume` | ✅ `--session` | ✅ `--session-id` |
| Live event stream | ✅ | ✅ | ✅ | one JSON per turn |

Every harness gets the same skills, the same `harness` MCP server and the same prompt contract. [docs/harnesses.md](docs/harnesses.md) lists the details and quirks of each one. Versions are pinned (`src/harness/versions.json`) and tested in CI; override them with `harness_version`.

## Models and providers

`model` is `provider/model`. API keys come from the environment: put them in `env:` on the step.

| provider | key | example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5.1-codex` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/qwen/qwen3-coder` |
| `groq`, `deepseek`, `mistral`, `xai`, `together`, `google` | `<PROVIDER>_API_KEY` (`GEMINI_API_KEY` for google) | `deepseek/deepseek-chat` |
| anything else | `api_key_env` | `base_url: https://my-gateway/v1` + `model: my/model-id` |

## What the agent can use

The **`harness` MCP server** is served to every harness. It is zero-dependency, needs no network access, and holds no token:

| tool | effect |
|---|---|
| `update_progress` | updates the checklist in the tracking comment |
| `report_finding` | file/line finding → annotation, SARIF, `fail_on` gate |
| `add_inline_comment` | PR review comment, posted as one review at the end; lines outside the diff move to the reply |
| `read_thread`, `get_pr_diff`, `get_ci_status` | context fetched before the run |
| `submit_structured_output` | the result for `json_schema`, with the schema as its input schema |
| `task_complete` | loop mode without `loop_until`: the agent declares the task done |

Extra MCP servers: `mcp_config` takes one portable JSON shape for every harness.

## Inputs

All inputs and their defaults are in [`action.yml`](action.yml). The main ones:

| input | default | |
|---|---|---|
| `harness` · `harness_version` | `opencode` · pinned | `opencode` (OpenCode 2), `codex`, `pi`, `openclaw` |
| `ask_mode` | `auto` | questions answered read-only with recommendations, action verbs change code (`always`, `off`) |
| `model` | — (required) | `provider/model` |
| `prompt` | — | set → automation mode; empty → tag mode (`@harness`, label, assignee) |
| `session` · `session_key` | `auto` · — | conversation memory per issue / PR (`on`, `off`), or a named conversation |
| `session_store` · `session_retention_days` | `artifact` · `30` | where conversations are kept (`artifact` or `cache`), and for how long |
| `loop_until` · `max_iterations` | — · 1 (5 with `loop_until`) | loop until a command passes / until `task_complete` |
| `open_pr` | `false` | open a pull request with the changes and the reply |
| `skills` / `skill` | — | skill sources (one per line) / the skill to use |
| `tools` | `auto` | `read-only`, `edit`, `full` (`auto`: tag → edit, automation → read-only) |
| `allow_bash` | — | shell commands allowed at `edit` |
| `trigger_phrase` · `label_trigger` · `assignee_trigger` | `@harness` · `harness` · — | tag mode triggers |
| `commit_mode` | `auto` | `auto`, `pr-branch`, `new-branch`, `none` |
| `use_sticky_comment` · `track_progress` · `post_comment` | `false` | comment behaviour |
| `allowed_bots` · `allowed_non_write_users` | — | who may trigger (default: users with write access) |
| `json_schema` | — | validated `structured_output` |
| `fail_on` · `on_agent_error` | — · `warn` | gates |
| `max_steps` · `timeout_minutes` · `budget_usd` | `200` · `30` · — | limits of an unattended run |
| `harness_args` · `harness_config` · `mcp_config` | — | escape hatches |

**Outputs:** `conclusion`, `mode`, `structured_output`, `findings_count`, `branch_name`, `pr_number`, `pr_url`, `session_id`, `resumed`, `iterations`, `cost_usd`, `execution_file`, `report_dir`.

## Coming from claude-code-action

| claude-code-action | harness-action |
|---|---|
| `@claude`, `label_trigger`, `assignee_trigger` | `@harness` (configurable), same triggers |
| tracking comment, `track_progress`, `use_sticky_comment` | same |
| GitHub MCP tools (comment, inline review, CI) | `harness` MCP server; the token never reaches the agent |
| `classify_inline_comments` | inline comments are buffered and posted as one review |
| branch + commits, `use_commit_signing` | commits through the API: **always signed (Verified)** |
| `plugins` / `plugin_marketplaces` | `skills` |
| `claude_args` / `settings` | `harness_args` / `harness_config` |
| `--json-schema` → `structured_output` | `json_schema` → `structured_output` |
| `allowed_bots`, `allowed_non_write_users`, `include/exclude_comments_by_actor` | same |
| each mention starts a new session | each mention **continues** the thread's session (`session`) |
| — | `loop_until` / `max_iterations`, `open_pr` |
| Claude only | any harness × any provider |

Not in v1: OIDC exchange for a hosted GitHub App (pass your own App token as `github_token` instead), and live progress updates while the agent runs. The checklist is published when the run ends, because no token is available during the run.

## Development

```bash
npm test                                   # unit tests (node:test, zero dependencies)
node test/e2e/run.mjs                      # real harnesses × scripted mock LLM × mock GitHub API
node test/e2e/run.mjs --harness pi --scenario pr-automation
```

The scenarios are `issue-tag`, `pr-automation` and `conversation-loop` (two runs: a loop that opens a PR, then a mention on it that must resume the session). Harnesses: `opencode`, `codex`, `pi`, `openclaw`. `e2e-live.yml` runs each harness on a **real model** (`ANTHROPIC_API_KEY`; Codex needs `OPENAI_API_KEY` or `OPENROUTER_API_KEY`): a skill run, a loop that must satisfy `loop_until`, and a second turn that must remember the first.

CI runs both on every push, plus `action.yml` itself (`uses: ./`): a smoke test, and a loop + conversation test that goes through the **real** session stores (artifact and cache). `.github/workflows/e2e-github.yml` checks the action against the **real** GitHub API (comments, reviews, branches, Verified commits, pull requests): comment `@harness-e2e harness=pi` on an issue or a PR of this repository (`expect=resumed` on a second comment), or run it from the Actions tab for the prompt → PR flow. `e2e-live.yml` runs real models (manual, needs provider secrets).

The e2e suite needs no API key. `test/mock-llm` speaks the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages APIs and replays a script, whatever harness is on the other end. `test/mock-github` records the comments, reviews, refs and GraphQL commits.

### Releases

Automatic: every push to `main` that passes CI is tagged from its conventional commits (`feat:` → minor, `fix:` and others → patch, `BREAKING CHANGE` → major), released, and listed on the Marketplace as the latest version. The floating tags `v2`, `v2.<minor>` and `marketplace` move with it, then `release-check.yml` runs the published tag as a user would. So `@v2` always gets the latest v2.

## License

MIT
