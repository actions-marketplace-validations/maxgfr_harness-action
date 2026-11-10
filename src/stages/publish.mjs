// Stage 3 (holds the GitHub token): replay the outbox, commit, comment, report, gate.
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/action.mjs';
import { readInputs, sessionCachePrefix, sessionArtifactName } from '../inputs.mjs';
import { createClient } from '../github/api.mjs';
import { collect, failsGate, validate } from '../contract.mjs';
import { treeChanges, restoreCredentials, commitViaApi, createBranch, commentableLines, isRepo, repoRoot } from '../git.mjs';
import { finalBody, summaryMarkdown, transcriptMarkdown, toSarif } from '../publish/render.mjs';
import { truncate } from '../util.mjs';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export function branchNameFor({ template, prefix, ctx, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const kind = ctx.isPR ? 'pr' : ctx.number ? 'issue' : 'run';
  const vars = { prefix, entityType: kind, entityNumber: ctx.number ?? '', timestamp: stamp, sha: (ctx.sha || '').slice(0, 7), description: (ctx.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) };
  const name = template
    ? template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''))
    : `${prefix}${kind}${ctx.number ? `-${ctx.number}` : ''}-${stamp}`;
  return name.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/]+|[-/.]+$/g, '');
}

export async function commitChanges({ github, inputs, context, workDir, reportDir }) {
  const { ctx, commitMode, pr } = context;
  if (!isRepo(workDir)) return { branch: null };
  // The whole repository, from its root: `working_directory` may be a sub-directory of it.
  const root = repoRoot(workDir);
  // Compared with the commit the run started from: an agent that committed locally (it is told
  // not to) still gets its work published.
  const changes = treeChanges(root, context.baseHead || 'HEAD');
  if (!changes.any) return { branch: null };
  fs.writeFileSync(path.join(reportDir, 'changes.patch'), changes.patch);
  core.info(`Working tree: ${changes.additions.length} file(s) added/modified, ${changes.deletions.length} deleted.`);
  if (commitMode === 'none') {
    core.notice(`The agent changed ${changes.additions.length + changes.deletions.length} file(s); commit_mode is none, so they are only saved as changes.patch in the artifact.`);
    return { branch: null, patch: true };
  }
  const request = String(context.request || '').replace(/\s+/g, ' ').replace(new RegExp(inputs.triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
  const headline = truncate(`${context.harness}: ${request || 'apply changes'}`, 72).replace(/… \(.*$/, '…');
  const coauthor = ctx.actorId ? `\n\nCo-authored-by: ${ctx.actor} <${ctx.actorId}+${ctx.actor}@users.noreply.github.com>` : '';
  const body = `Requested by @${ctx.actor}${ctx.number ? ` in #${ctx.number}` : ''}.\nRun: ${ctx.runUrl}${coauthor}`;
  let branch;
  let created = false;
  if (commitMode === 'pr-branch') {
    branch = pr.headRef;
  } else if (commitMode === 'continue-branch') {
    branch = context.targetBranch; // the branch an earlier turn of this conversation created
  } else {
    branch = branchNameFor({ template: inputs.branchNameTemplate, prefix: inputs.branchPrefix, ctx });
    await createBranch({ github, owner: ctx.owner, repo: ctx.repo, branch, sha: context.baseHead });
    created = true;
  }
  const commitArgs = { github, owner: ctx.owner, repo: ctx.repo, branch, expectedHeadOid: context.baseHead, cwd: root, headline, body };
  let commit;
  let leftOut = [];
  try {
    try {
      commit = await commitViaApi({ ...commitArgs, changes });
    } catch (err) {
      // The job token can never change workflow files ("Resource not accessible by
      // integration"): commit the rest, keep those in changes.patch.
      const { kept, workflows } = splitWorkflowChanges(changes);
      if (!workflows.length || !/not accessible|workflow/i.test(err.message)) throw err;
      if (!kept.additions.length && !kept.deletions.length) throw new Error(`${err.message}. The agent only changed workflow files (${workflows.join(', ')}), which the job token cannot commit: they are in changes.patch. Use a GitHub App token with the "workflows" permission as github_token to let it change workflows.`);
      commit = await commitViaApi({ ...commitArgs, changes: kept, body: `${body}\n\nLeft out (workflow files need a token with the workflows permission): ${workflows.join(', ')}` });
      leftOut = workflows;
      core.warning(`Left ${workflows.length} workflow file(s) out of the commit: ${workflows.join(', ')}. The job token cannot change .github/workflows; they are in changes.patch. Pass a GitHub App token with the "workflows" permission as github_token to commit them.`);
    }
  } catch (err) {
    // Never leave behind an empty branch the action just created.
    if (created) await github.request('DELETE', `/repos/${ctx.owner}/${ctx.repo}/git/refs/heads/${branch}`).catch(() => {});
    throw err;
  }
  core.info(`Committed ${commit.oid.slice(0, 7)} to ${branch} (signed by GitHub).`);
  const repoUrl = `${ctx.serverUrl}/${ctx.owner}/${ctx.repo}`;
  const continued = commitMode === 'continue-branch';
  const baseBranch = inputs.baseBranch || (continued ? ctx.defaultBranch : context.branchName) || ctx.defaultBranch;
  const prUrl = (created || continued) && !ctx.isPR
    ? `${repoUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?quick_pull=1&title=${encodeURIComponent(truncate(ctx.title || headline, 120))}&body=${encodeURIComponent(`${ctx.number ? `Closes #${ctx.number}\n\n` : ''}Generated by ${context.harness} (${context.model}) — ${ctx.runUrl}`)}`
    : null;
  return { branch: { name: branch, created, url: `${repoUrl}/tree/${encodeURIComponent(branch)}`, commitUrl: commit.url, prUrl, sha: commit.oid, base: baseBranch, headline, leftOut } };
}

const WORKFLOW_FILE = /^\.github\/workflows\//;

/** Workflow files apart: GitHub refuses them to the job token. */
export function splitWorkflowChanges(changes) {
  const workflows = [...changes.additions, ...changes.deletions].filter((p) => WORKFLOW_FILE.test(p));
  return {
    workflows,
    kept: { additions: changes.additions.filter((p) => !WORKFLOW_FILE.test(p)), deletions: changes.deletions.filter((p) => !WORKFLOW_FILE.test(p)), any: true },
  };
}

/** open_pr: turn the new branch into a pull request whose description is the agent's reply. */
export async function openPullRequest({ github, context, branch, finalText, harness, model }) {
  const { ctx } = context;
  const title = truncate(ctx.title || branch.headline.replace(new RegExp(`^${harness}: `), ''), 120).replace(/… \(.*$/, '…');
  const body = [
    finalText?.trim() || '_The agent did not produce a final message._',
    '',
    ctx.number && !ctx.isPR ? `Closes #${ctx.number}` : '',
    '',
    `<sub>Opened by **${harness}** · \`${model}\` · [job run](${ctx.runUrl}). Mention the trigger phrase in this pull request to continue the conversation.</sub>`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const pr = await github.post(`/repos/${ctx.owner}/${ctx.repo}/pulls`, { title, head: branch.name, base: branch.base, body, maintainer_can_modify: true });
  core.info(`Opened pull request #${pr.number}: ${pr.html_url}`);
  return { number: pr.number, url: pr.html_url };
}

async function postReview({ github, context, inline, stateDir }) {
  const { ctx, pr } = context;
  if (!pr || !inline.length) return { posted: 0, outside: [] };
  const diff = fs.existsSync(path.join(stateDir, 'pr.diff')) ? fs.readFileSync(path.join(stateDir, 'pr.diff'), 'utf8') : '';
  const lines = commentableLines(diff);
  const inside = [];
  const outside = [];
  for (const c of inline) {
    const ok = lines.get(c.path)?.has(Number(c.line)) && (!c.start_line || lines.get(c.path)?.has(Number(c.start_line)));
    (ok ? inside : outside).push(c);
  }
  if (!inside.length) return { posted: 0, outside };
  const comments = inside.map((c) => ({
    path: c.path,
    line: Number(c.line),
    side: 'RIGHT',
    body: c.body,
    ...(c.start_line && Number(c.start_line) < Number(c.line) ? { start_line: Number(c.start_line), start_side: 'RIGHT' } : {}),
  }));
  try {
    await github.post(`/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}/reviews`, { commit_id: pr.headSha, event: 'COMMENT', body: '', comments });
    return { posted: comments.length, outside };
  } catch (err) {
    core.warning(`Could not post the review (${err.message}); the comments are listed in the reply instead.`);
    return { posted: 0, outside: [...inside, ...outside] };
  }
}

export async function publish({ env = process.env, stateDir }) {
  const inputs = readInputs(env);
  const context = readJson(path.join(stateDir, 'context.json'), { run: false, mode: 'skip' });
  const set = core.setOutput;
  set('mode', context.mode ?? 'skip');
  set('harness', inputs.harness);
  set('model', inputs.model);
  if (!context.run) {
    set('conclusion', 'skipped');
    return { exitCode: 0 };
  }
  const { ctx } = context;
  const workDir = context.workDir;
  const reportDir = path.join(stateDir, 'report');
  fs.mkdirSync(reportDir, { recursive: true });
  const github = createClient({ token: inputs.githubToken });
  const runFile = path.join(stateDir, 'run.json');
  const run = readJson(runFile);

  if (context.removedCredentials) restoreCredentials(workDir, context.removedCredentials, inputs.githubToken, ctx.serverUrl);

  const status = run?.status ?? 'error';
  const { findings, inline, progress, structured } = collect(stateDir);
  const errors = [];
  if (!run) errors.push('The harness did not run (the run step failed before writing its result).');
  else if (status !== 'success') errors.push(run.killedReason || run.errors?.at(-1) || `${inputs.harness} ${status}`);
  // loop mode: the completion check must have passed
  const loopFailed = Boolean(run && status === 'success' && run.loopUntil && run.loopResult !== 'passed');
  if (loopFailed) errors.push(`The completion check \`${run.loopUntil}\` still fails after ${run.iterations?.length ?? 0} iteration(s) (max_iterations).`);

  // structured output
  let structuredErrors = [];
  if (inputs.jsonSchema) {
    if (!structured) structuredErrors = ['the agent did not call submit_structured_output'];
    else structuredErrors = validate(inputs.jsonSchema, structured);
    if (structuredErrors.length) errors.push(`Structured output invalid: ${structuredErrors.slice(0, 5).join('; ')}`);
  }

  // git
  let branch = null;
  try {
    ({ branch } = await commitChanges({ github, inputs, context, workDir, reportDir }));
  } catch (err) {
    errors.push(`Could not commit the changes: ${err.message}`);
    core.warning(`Could not commit the changes: ${err.message}`);
  }

  // open_pr
  let pull = null;
  if (context.openPr && branch?.created && !ctx.isPR) {
    try {
      pull = await openPullRequest({ github, context, branch, finalText: run?.finalText, harness: inputs.harness, model: inputs.model });
      branch.pullUrl = pull.url;
      branch.pullNumber = pull.number;
    } catch (err) {
      const hint = /not permitted to create/i.test(err.message)
        ? ' Enable Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests", or pass a GitHub App token as github_token. The changes are on the branch; use the Create-PR link.'
        : '';
      core.warning(`Could not open the pull request: ${err.message}.${hint}`);
    }
  }

  // conversation: saved by the artifact (or cache) step after this one, under the PR when one
  // was opened
  let sessionSaveKey = '';
  let sessionArtifact = '';
  const sessionDir = context.session?.dir;
  if (context.session?.thread && sessionDir && fs.existsSync(path.join(sessionDir, 'meta.json'))) {
    // Remember the branch of an issue conversation, so the next turn continues on it.
    if (branch?.name && !ctx.isPR && !pull) {
      const metaFile = path.join(sessionDir, 'meta.json');
      const meta = readJson(metaFile, {});
      fs.writeFileSync(metaFile, JSON.stringify({ ...meta, branch: branch.name }, null, 2));
    }
    const thread = pull ? `pr-${pull.number}` : context.session.thread;
    const id = context.adapterId ?? inputs.harness;
    if ((context.session.store ?? inputs.sessionStore) === 'cache') {
      // Cache entries are immutable: each save gets its own key; restore takes the newest by prefix.
      sessionSaveKey = `${sessionCachePrefix(id, thread)}${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}-${Date.now()}`;
    } else {
      sessionArtifact = sessionArtifactName(id, thread);
    }
  }

  // review
  const review = await postReview({ github, context, inline, stateDir });

  // reports on disk (uploaded as the artifact)
  const blobUrl = `${ctx.serverUrl}/${ctx.owner}/${ctx.repo}/blob/${branch?.sha || context.pr?.headSha || ctx.sha}`;
  fs.writeFileSync(path.join(reportDir, 'findings.json'), JSON.stringify(findings, null, 2));
  if (structured) fs.writeFileSync(path.join(reportDir, 'structured_output.json'), JSON.stringify(structured, null, 2));
  fs.writeFileSync(path.join(reportDir, 'final.md'), run?.finalText ?? '');
  let sarifFile = '';
  if (inputs.sarif) {
    sarifFile = path.join(reportDir, 'results.sarif');
    fs.writeFileSync(sarifFile, JSON.stringify(toSarif(findings, { harness: inputs.harness, version: context.version }), null, 2));
  }

  // annotations
  if (inputs.annotations) {
    for (const f of findings.slice(0, 50)) {
      const fn = f.severity === 'error' ? core.error : f.severity === 'warning' ? core.warning : core.notice;
      fn(f.message, { file: f.file || undefined, line: f.line, endLine: f.endLine, title: f.title || f.rule || 'harness' });
    }
  }

  // comment
  const errorText = errors.join('\n');
  if (context.trackingCommentId) {
    const body = finalBody({
      sticky: context.sticky,
      harness: inputs.harness,
      model: inputs.model,
      runUrl: ctx.runUrl,
      run,
      status: errors.length && status === 'success' ? 'error' : status,
      finalText: run?.finalText,
      progress,
      branch,
      findings,
      outsideDiff: review.outside,
      blobUrl,
      errorText,
      review: review.posted,
    });
    await github.patch(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${context.trackingCommentId}`, { body }).catch((err) => core.warning(`Could not update the comment: ${err.message}`));
  }

  // job summary
  const events = fs.existsSync(path.join(reportDir, 'execution.jsonl'))
    ? fs.readFileSync(path.join(reportDir, 'execution.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  core.summary(summaryMarkdown({
    harness: inputs.harness,
    version: context.version,
    model: inputs.model,
    mode: context.mode,
    status,
    run,
    finalText: run?.finalText,
    findings,
    branch,
    structured,
    transcript: inputs.displayReport ? transcriptMarkdown(events) : '',
    errorText,
    blobUrl,
  }));

  // outputs
  const agentFailed = status !== 'success' || structuredErrors.length > 0 || loopFailed;
  set('conclusion', agentFailed ? 'failure' : 'success');
  set('pr_number', pull ? String(pull.number) : '');
  set('pr_url', pull?.url ?? '');
  set('iterations', String(run?.iterations?.length ?? 0));
  set('resumed', String(Boolean(run?.resumed)));
  set('session_save_key', sessionSaveKey);
  set('session_artifact', sessionArtifact);
  set('session_dir', sessionSaveKey || sessionArtifact ? sessionDir : '');
  set('execution_file', path.join(reportDir, 'execution.jsonl'));
  set('report_dir', reportDir);
  set('branch_name', branch?.name ?? '');
  set('session_id', run?.sessionId ?? '');
  set('structured_output', structured && !structuredErrors.length ? JSON.stringify(structured) : '');
  set('cost_usd', run?.costKnown ? run.cost.toFixed(6) : '');
  set('findings_count', String(findings.length));
  set('sarif_file', sarifFile);

  // gate
  const blocking = failsGate(findings, inputs.failOn);
  let exitCode = 0;
  if (blocking.length) {
    core.error(`${blocking.length} finding(s) at or above "${inputs.failOn}" (fail_on).`);
    exitCode = 1;
  }
  if (agentFailed) {
    const msg = `The agent run did not succeed: ${errorText || status}`;
    if (inputs.onAgentError === 'fail') { core.error(msg); exitCode = 1; } else core.warning(`${msg} (on_agent_error: warn)`);
  }
  return { exitCode };
}
