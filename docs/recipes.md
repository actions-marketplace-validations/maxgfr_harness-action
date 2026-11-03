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
      - uses: maxgfr/harness-action@v1
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
- uses: maxgfr/harness-action@v1
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
