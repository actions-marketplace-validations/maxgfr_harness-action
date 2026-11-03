# harness-action

**Run a real coding-agent harness in GitHub Actions — any model, any Agent Skill.**

`harness-action` drives an open-source agent harness — **[OpenCode](https://opencode.ai)**, **[Codex](https://github.com/openai/codex)**, **[Pi](https://pi.dev)** or **[claw-code](https://github.com/ultraworkers/claw-code)** — inside your workflow, with the model and provider you choose, and the [Agent Skills](https://agentskills.io) (`SKILL.md`) you point it at. It does what you expect from an agent action — `@mention` it on an issue or a PR, it replies, tracks its progress, pushes **signed** commits, posts reviews, and reports results — without being tied to one vendor's model.

```yaml
- uses: maxgfr/harness-action@v1
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
  with:
    harness: opencode                     # opencode | codex | pi | claw
    model: openrouter/qwen/qwen3-coder    # provider/model
    skills: your-org/your-skills          # any repo with SKILL.md files
```

## Why

- **Any model.** Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Gemini, Ollama, or any OpenAI-compatible endpoint (`base_url`).
- **Any harness.** Pick the agent loop that suits the model: OpenCode (default), Codex, Pi, or claw-code (experimental).
- **Any skill.** Install skills from any repository (`owner/repo@ref#skill`), or use the ones committed in yours (`.agents/`, `.claude/`, `.opencode/`, `.claw/skills`). Each harness gets them at its own discovery path.
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
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-5-5
          allow_bash: |
            npm test*
            npm run lint*
```

Comment `@harness fix the flaky date test` on an issue. The agent replies in a tracking comment and updates its checklist as it goes. Its changes land on a new `harness/issue-N-…` branch as a **Verified** commit, and the reply ends with a *Create PR* link. On a pull request, it pushes to the PR branch and can leave line-level review comments.

### 2. Review every pull request with a skill

```yaml
on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: write, security-events: write }
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v1
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
        uses: maxgfr/harness-action@v1
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

## Harnesses

| | OpenCode | Codex | Pi | claw-code |
|---|---|---|---|---|
| Status | **default**, stable | stable | stable | experimental |
| Install | npm `opencode-ai` | npm `@openai/codex` | npm `@earendil-works/pi-coding-agent` | built from source (cargo, ~1 min, cached) |
| Providers | ~75 built in + any OpenAI/Anthropic-compatible | OpenAI + any OpenAI-compatible (Responses API) | ~15 built in + any compatible | Anthropic, OpenAI-compatible, xAI, DashScope, Ollama |
| `allow_bash` patterns | ✅ enforced per pattern | sandboxed shell instead | bash all-or-nothing | needs `tools: full` |
| Cost reported (`budget_usd`) | ✅ | ❌ (step / time limits only) | ✅ | ✅ (after the run) |
| Live event stream | ✅ | ✅ | ✅ | one JSON at the end |

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

Extra MCP servers: `mcp_config` takes one portable JSON shape for every harness.

## Inputs

All inputs and their defaults are in [`action.yml`](action.yml). The main ones:

| input | default | |
|---|---|---|
| `harness` | `opencode` | `opencode`, `codex`, `pi`, `claw` |
| `model` | — (required) | `provider/model` |
| `prompt` | — | set → automation mode; empty → tag mode (`@harness`, label, assignee) |
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

**Outputs:** `conclusion`, `mode`, `structured_output`, `findings_count`, `branch_name`, `session_id`, `cost_usd`, `execution_file`, `report_dir`.

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
| Claude only | any harness × any provider |

Not in v1: OIDC exchange for a hosted GitHub App (pass your own App token as `github_token` instead), and live progress updates while the agent runs. The checklist is published when the run ends, because no token is available during the run.

## Development

```bash
npm test                                   # unit tests (node:test, zero dependencies)
node test/e2e/run.mjs                      # real harnesses × scripted mock LLM × mock GitHub API
node test/e2e/run.mjs --harness pi --scenario pr-automation
```

CI runs both on every push, plus a smoke test of `action.yml` itself (`uses: ./`). `.github/workflows/e2e-github.yml` checks the action against the **real** GitHub API (comments, reviews, branches, Verified commits): comment `@harness-e2e harness=pi` on an issue or a PR of this repository. `e2e-live.yml` runs real models (manual, needs provider secrets).

The e2e suite needs no API key. `test/mock-llm` speaks the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages APIs and replays a script, whatever harness is on the other end. `test/mock-github` records the comments, reviews, refs and GraphQL commits.

## License

MIT
