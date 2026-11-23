# Recipes

## Mixed models: a cheap triage, a strong fix

```yaml
on:
  issues: { types: [opened] }
jobs:
  triage:
    runs-on: ubuntu-latest
    permissions: { issues: write, contents: read }
    steps:
      - uses: actions/checkout@v7
      - uses: maxgfr/harness-action@v2
        env: { GROQ_API_KEY: '${{ secrets.GROQ_API_KEY }}' }
        with:
          model: groq/llama-4-maverick
          prompt: Classify this issue (bug / feature / question), check for duplicates and answer in two sentences.
          track_progress: true
```

…and a `@harness` workflow on `anthropic/claude-sonnet-5-5` (or `openai/gpt-5.1-codex` with `harness: codex`) for the actual fixes.

## Several skills, one of them private

```yaml
with:
  skills: |
    your-org/public-skills@v3
    your-org/private-skills#release-notes
    ./tools/skills
  skills_token: ${{ secrets.SKILLS_READ_TOKEN }}
  skill: release-notes
```

## A local or self-hosted model

```yaml
with:
  harness: pi
  model: vllm/qwen3-coder-30b
  base_url: http://gpu-box.internal:8000/v1
  api_key_env: VLLM_API_KEY
```

## Act as your own bot (GitHub App)

```yaml
- uses: actions/create-github-app-token@v3
  id: app
  with:
    app-id: ${{ vars.APP_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
- uses: maxgfr/harness-action@v2
  with:
    github_token: ${{ steps.app.outputs.token }}
    model: anthropic/claude-sonnet-5-5
```

Commits made with an App token are signed by GitHub, and they trigger your other workflows, which `GITHUB_TOKEN` commits do not.

## Gate a pull request on a skill's findings

```yaml
with:
  skills: your-org/checks#accessibility
  skill: accessibility
  prompt: Check the changed files. Report every violation with report_finding (severity error for blocking ones).
  fail_on: error
  sarif: true          # needs security-events: write
  annotations: true
```

## Extra MCP servers (portable across harnesses)

```yaml
with:
  mcp_config: |
    {
      "docs": { "url": "https://docs.example.com/mcp", "headers": { "Authorization": "Bearer ${{ secrets.DOCS_TOKEN }}" } },
      "db":   { "command": "npx", "args": ["-y", "@example/db-mcp"], "env": { "DB_URL": "${{ secrets.RO_DB_URL }}" } }
    }
```

## Reusable workflows

Two workflows of this repository can be called instead of writing the job: `reusable-bot.yml` (tag mode, Quick start 1) and `reusable-review.yml` (pull request review, Quick start 2). Pin them like the action, `@v2`.

**Permissions.** A called workflow gets at most what its caller grants: set the `permissions:` block on the calling job, or the run fails before it starts.

**Secrets.** `secrets: inherit` hands over every secret of the repository. To pass only what is needed, list them: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, all optional. `HARNESS_GITHUB_TOKEN` replaces the job token (a name that starts with `GITHUB_` is reserved). A provider that needs `base_url` / `api_key_env` needs the action itself.

### The bot

```yaml
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
  issues: { types: [opened, assigned, labeled] }
jobs:
  harness:
    # optional: skip unrelated comments without starting a runner, one agent per conversation
    if: contains(github.event.comment.body || github.event.issue.body || '', '@harness') || github.event.action == 'labeled' || github.event.action == 'assigned'
    concurrency: { group: 'harness-${{ github.event.issue.number || github.event.pull_request.number }}' }
    permissions: { contents: write, pull-requests: write, issues: write, actions: read }
    uses: maxgfr/harness-action/.github/workflows/reusable-bot.yml@v2
    with:
      model: anthropic/claude-sonnet-5-5
      loop_until: npm test
      allow_bash: |
        npm test*
        npm run lint*
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Inputs: `model` (required), `harness` (`opencode`), `harness_version`, `skills`, `skill`, `allow_bash`, `trigger_phrase` (`@harness`; several, comma or newline separated), `ask_mode` (`auto`), `loop_until`, `max_iterations`, `timeout_minutes` (`30`), `runs_on` (`ubuntu-latest`, or a JSON array of labels). The workflow does not filter on the trigger phrase itself, since an expression cannot split a list: the action exits in seconds when the event does not trigger it. The `if:` above is the cheaper filter for a caller with one phrase.

### The review

```yaml
on: { pull_request: { types: [opened, synchronize, ready_for_review] } }
jobs:
  review:
    permissions: { contents: read, pull-requests: write, issues: write, security-events: write }
    uses: maxgfr/harness-action/.github/workflows/reusable-review.yml@v2
    with:
      harness: codex
      model: openai/gpt-5.1-codex
      skills: your-org/review-skills#security-review
      skill: security-review
      fail_on: error
    secrets: inherit
```

Inputs: `model` (required), `harness` (`opencode`), `harness_version`, `skills`, `skill`, `prompt` (review the changes, `report_finding`, inline comments), `fail_on` (never), `sarif` (`true`), `post_comment` (`true`), `trusted_associations` (`["OWNER","MEMBER","COLLABORATOR"]`, a JSON array), `runs_on`. The job is skipped for drafts, bot authors and authors whose `author_association` is not in `trusted_associations`. A new push cancels the review in progress.
