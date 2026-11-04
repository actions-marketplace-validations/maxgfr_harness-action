// Everything that turns a run into Markdown / SARIF.
import { truncate } from '../util.mjs';

export const TRACKING_MARKER = '<!-- harness-action:tracking -->';
export const stickyMarker = (id) => `<!-- harness-action:sticky:${id} -->`;

const SEV_ICON = { error: '🔴', warning: '🟠', notice: '🔵' };
const STATUS = {
  success: '✅',
  error: '❌',
  timeout: '⏱️',
  budget: '💸',
  max_steps: '🛑',
};

export function workingBody({ harness, model, runUrl, marker = TRACKING_MARKER, sticky }) {
  return [
    marker,
    sticky ?? '',
    `**${harness}** is working… <img src="https://github.githubassets.com/images/spinners/octocat-spinner-32.gif" width="14" alt="" />`,
    '',
    `\`${model}\` · [View job run](${runUrl})`,
  ].filter((l) => l !== '').join('\n');
}

export function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function footer({ harness, model, run, runUrl }) {
  const bits = [`**${harness}**`, `\`${model}\``];
  if (run) {
    bits.push(formatDuration(run.durationMs));
    if (run.costKnown) bits.push(`$${run.cost.toFixed(4)}`);
    bits.push(`${run.tools} tool call${run.tools === 1 ? '' : 's'}`);
  }
  bits.push(`[job run](${runUrl})`);
  return `<sub>${bits.join(' · ')}</sub>`;
}

export function findingsTable(findings, { max = 30, blobUrl } = {}) {
  if (!findings.length) return '';
  const rows = findings.slice(0, max).map((f) => {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—';
    const link = blobUrl && f.file ? `[\`${loc}\`](${blobUrl}/${f.file}${f.line ? `#L${f.line}${f.endLine ? `-L${f.endLine}` : ''}` : ''})` : `\`${loc}\``;
    return `| ${SEV_ICON[f.severity]} ${f.severity} | ${link} | ${(f.title ? `**${f.title}** — ` : '') + f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`;
  });
  const more = findings.length > max ? `\n\n…and ${findings.length - max} more (see the job summary / artifact).` : '';
  return `| Severity | Location | Finding |\n|---|---|---|\n${rows.join('\n')}${more}`;
}

export function finalBody({ marker = TRACKING_MARKER, sticky, harness, model, runUrl, run, status, finalText, progress, branch, findings = [], outsideDiff = [], blobUrl, errorText, review }) {
  const L = [marker];
  if (sticky) L.push(sticky);
  const icon = STATUS[status] ?? '❔';
  const head = status === 'success' ? `${icon} **${harness}** finished` : `${icon} **${harness}** ${status === 'error' ? 'failed' : `stopped (${status.replace('_', ' ')})`}`;
  L.push(`${head} · [View job run](${runUrl})`);
  if (errorText) L.push('', `> ${truncate(errorText, 1500).replace(/\n/g, '\n> ')}`);
  if (progress) L.push('', '<details><summary>Progress</summary>', '', progress, '', '</details>');
  if (branch) {
    const pr = branch.pullUrl ? ` · [**Pull request #${branch.pullNumber} ➔**](${branch.pullUrl})` : branch.prUrl ? ` · [**Create PR ➔**](${branch.prUrl})` : '';
    L.push('', `🌿 ${branch.created ? 'New branch' : 'Pushed to'} [\`${branch.name}\`](${branch.url})${branch.commitUrl ? ` · [commit](${branch.commitUrl})` : ''}${pr}`);
    if (branch.leftOut?.length) L.push('', `> ⚠️ Not committed — the job token cannot change workflow files: ${branch.leftOut.map((p) => `\`${p}\``).join(', ')}. They are in \`changes.patch\` (report artifact); a GitHub App token with the *workflows* permission as \`github_token\` can commit them.`);
  }
  if (review) L.push('', `💬 Posted a review with ${review} inline comment${review === 1 ? '' : 's'}.`);
  const loopText = loopLine(run);
  if (loopText) L.push('', loopText);
  L.push('', '---', '');
  L.push(finalText?.trim() ? finalText.trim() : '_The agent did not produce a final message._');
  if (findings.length) L.push('', `<details><summary>${findings.length} finding${findings.length === 1 ? '' : 's'}</summary>`, '', findingsTable(findings, { blobUrl }), '', '</details>');
  if (outsideDiff.length) {
    L.push('', '<details><summary>Review comments outside the diff</summary>', '');
    for (const c of outsideDiff) L.push(`- \`${c.path}:${c.line}\` — ${c.body.replace(/\n/g, ' ')}`);
    L.push('', '</details>');
  }
  L.push('', footer({ harness, model, run, runUrl }));
  return truncate(L.join('\n'), 64000);
}

/** "🔁 3 iterations · `npm test` passed" / "↺ continued the conversation". */
export function loopLine(run) {
  if (!run) return '';
  const bits = [];
  if (run.resumed) bits.push('↺ continued the conversation');
  const n = run.iterations?.length ?? 0;
  if (run.loopResult && run.loopResult !== 'single') {
    const outcome = { passed: `\`${run.loopUntil}\` passed`, complete: 'task_complete called', exhausted: run.loopUntil ? `\`${run.loopUntil}\` still failing` : 'not declared complete', stopped: 'stopped' }[run.loopResult] ?? run.loopResult;
    bits.push(`🔁 ${n} iteration${n === 1 ? '' : 's'} · ${outcome}`);
  }
  return bits.join(' · ');
}

export function summaryMarkdown({ harness, version, model, mode, status, run, finalText, findings, branch, structured, transcript, errorText, blobUrl }) {
  const L = [];
  L.push(`## ${STATUS[status] ?? '❔'} harness-action — ${harness}`);
  L.push('');
  L.push('| | |', '|---|---|');
  L.push(`| Harness | \`${harness}@${String(version).slice(0, 12)}\` |`);
  L.push(`| Model | \`${model}\` |`);
  L.push(`| Mode | ${mode} |`);
  L.push(`| Status | ${status} |`);
  if (run) {
    L.push(`| Duration | ${formatDuration(run.durationMs)} |`);
    L.push(`| Tool calls | ${run.tools} |`);
    L.push(`| Tokens | ${run.inputTokens} in / ${run.outputTokens} out |`);
    L.push(`| Cost | ${run.costKnown ? `$${run.cost.toFixed(4)}` : 'not reported by this harness'} |`);
  }
  if (run?.iterations?.length > 1 || run?.resumed) L.push(`| Loop / session | ${loopLine(run)} |`);
  if (branch) L.push(`| Branch | [\`${branch.name}\`](${branch.url}) |`);
  if (branch?.pullUrl) L.push(`| Pull request | [#${branch.pullNumber}](${branch.pullUrl}) |`);
  else if (branch?.prUrl) L.push(`| Pull request | [Create PR ➔](${branch.prUrl}) |`);
  L.push('');
  if (errorText) L.push(`> [!WARNING]\n> ${truncate(errorText, 2000).replace(/\n/g, '\n> ')}`, '');
  if (finalText) L.push('### Result', '', finalText.trim(), '');
  if (findings?.length) L.push(`### Findings (${findings.length})`, '', findingsTable(findings, { max: 200, blobUrl }), '');
  if (structured) L.push('### Structured output', '', '```json', JSON.stringify(structured, null, 2), '```', '');
  if (transcript) L.push('<details><summary>Transcript</summary>', '', transcript, '', '</details>');
  return L.join('\n');
}

export function transcriptMarkdown(events, { max = 400 } = {}) {
  const L = [];
  for (const ev of events.slice(0, max)) {
    if (ev.t === 'text') L.push(`**assistant:** ${truncate(ev.text, 4000)}`, '');
    else if (ev.t === 'tool') L.push(`🔧 \`${ev.name}\` \`${truncate(JSON.stringify(ev.input ?? {}), 300)}\``);
    else if (ev.t === 'tool_result' && ev.error) L.push(`   ✗ ${truncate(ev.error, 300)}`);
    else if (ev.t === 'error') L.push(`❌ ${ev.message}`);
  }
  if (events.length > max) L.push(`…${events.length - max} more events in the execution file.`);
  return L.join('\n');
}

export function toSarif(findings, { harness, version }) {
  const rules = new Map();
  for (const f of findings) {
    const id = f.rule || 'harness-finding';
    if (!rules.has(id)) rules.set(id, { id, shortDescription: { text: f.title || id } });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: `harness-action/${harness}`, version: String(version), informationUri: 'https://github.com/maxgfr/harness-action', rules: [...rules.values()] } },
      results: findings.map((f) => ({
        ruleId: f.rule || 'harness-finding',
        level: f.severity === 'notice' ? 'note' : f.severity,
        message: { text: f.title ? `${f.title}: ${f.message}` : f.message },
        locations: f.file ? [{ physicalLocation: { artifactLocation: { uri: f.file }, ...(f.line ? { region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) } } : {}) } }] : [],
      })),
    }],
  };
}
