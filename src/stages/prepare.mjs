// Stage 1 (holds the GitHub token): decide whether to run, gather context, install everything,
// write a token-free plan for the run stage.
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/action.mjs';
import { readInputs, effectiveTools, splitModel, loopSettings, sessionThread, sessionArtifactName } from '../inputs.mjs';
import { restoreSessionArtifact } from '../github/session-store.mjs';
import { readContext } from '../github/context.mjs';
import { createClient } from '../github/api.mjs';
import { detectMode, checkAccess, wantsTrackingComment, keepCommentAuthor, intentFor } from '../modes.mjs';
import { resolveHarness, permissionProfile, MCP_SERVER, splitArgs } from '../harness/index.mjs';
import { resolveEndpoint } from '../harness/providers.mjs';
import { installSkills, repositorySkillNames } from '../skills.mjs';
import { buildPrompt, buildFollowupPrompt } from '../prompt.mjs';
import { git, isRepo, headSha, stripCredentials } from '../git.mjs';
import { TRACKING_MARKER, stickyMarker, workingBody } from '../publish/render.mjs';
import { truncate } from '../util.mjs';
import { toolDefinitions } from '../mcp/server.mjs';
import { uncheckedKeywords } from '../contract.mjs';

const MAX_DIFF = 2 * 1024 * 1024;

/** A previous reply of the agent, reduced to what it said (markers, spinner and footer removed). */
export function previousReply(body) {
  return String(body)
    .replace(/<!-- harness-action:[^>]*-->\n?/g, '')
    .replace(/\n<sub>[^\n]*<\/sub>\s*$/, '') // the footer: the last line, and only that one
    .trim();
}

/**
 * A generated harness configuration as it may be shown in the report artifact, which anyone who
 * can read the repository can download: the `headers` and `env` values of the user's MCP servers
 * (tokens, connection strings) are replaced. Every harness config writes them as quoted strings.
 */
export function redactMcpSecrets(text, mcpConfig) {
  let out = String(text);
  for (const server of Object.values(mcpConfig ?? {})) {
    for (const group of [server?.headers, server?.env]) {
      for (const value of Object.values(group ?? {})) {
        if (typeof value === 'string' && value) out = out.split(JSON.stringify(value)).join('"***"');
      }
    }
  }
  return out;
}

/**
 * Must the working tree be moved to the head of the pull request before the agent runs?
 *   'required'    — the changes are pushed to that branch: without it the run cannot work;
 *   'best-effort' — a run that commits nothing (a question, `tools: read-only`) started from a
 *                   comment: the event belongs to the issue, so the checkout is the default
 *                   branch, and the agent would answer about the wrong code;
 *   null          — already there, no pull request, or a fork (its code is not checked out next
 *                   to the provider keys on a comment).
 */
export function prCheckout({ pr, commitMode, eventName, atHead }) {
  if (!pr || atHead) return null;
  if (commitMode === 'pr-branch') return 'required';
  if (commitMode === 'none' && eventName === 'issue_comment' && !pr.isFork) return 'best-effort';
  return null;
}

/**
 * The branch a restored conversation asks to continue on, or '' when it is not one this action
 * would have created. The value comes from a saved artifact: it is never allowed to point the
 * next commit at the default branch, at `base_branch`, or (unless a `branch_name_template`
 * makes names free-form) outside `branch_prefix`.
 */
export function conversationBranch(branch, { defaultBranch = '', baseBranch = '', prefix = '', template = '' } = {}) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) return '';
  if (branch === defaultBranch || branch === baseBranch) return '';
  if (!template && prefix && !branch.startsWith(prefix)) return '';
  return branch;
}

const hasMarker = (c) => String(c.body ?? '').includes(TRACKING_MARKER) || String(c.body ?? '').includes('<!-- harness-action:sticky:');

/**
 * Was this comment written by the action's token? `self` is the login behind a personal token;
 * a job or app token has none (`null`) and always writes as a bot.
 */
export function isOwnComment(comment, self) {
  const login = comment.user?.login ?? '';
  return self ? login === self : comment.user?.type === 'Bot' || /\[bot\]$/i.test(login);
}

/**
 * The comments of a thread that are the action's own, as a set of ids. The hidden markers are
 * plain text anyone can paste into a comment: they only count when the author is the token's
 * identity. Otherwise a stranger's text would be shown to the model as its own earlier reply
 * (and skip the author filters), or be taken for the sticky comment and overwritten.
 */
export function ownComments(github) {
  let self; // undefined: not asked yet
  return async (comments) => {
    const marked = comments.filter(hasMarker);
    if (!marked.length) return new Set();
    // (`GET /user` answers for a personal token only; it is refused to job and app tokens)
    if (self === undefined) self = await github.get('/user').then((u) => u?.login ?? null, () => null);
    return new Set(marked.filter((c) => isOwnComment(c, self)).map((c) => c.id));
  };
}

/**
 * The comments of the issue / pull request, listed once per run however many callers ask (the
 * sticky-comment lookup and the thread both need them).
 */
export function commentLister(github, ctx) {
  let list = null;
  // (in a thread longer than that, the newest comments: the event says how many there are)
  return () => (list ??= github.paginate(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`, { max: 500, total: ctx.entity?.comments ?? 0 }));
}

export async function buildThread({ github, ctx, inputs, isPR, currentCommentId, own, listComments = commentLister(github, ctx) }) {
  const { owner, repo, number } = ctx;
  // independent requests: one round trip instead of three
  const [entity, comments, reviews] = await Promise.all([
    isPR ? github.get(`/repos/${owner}/${repo}/pulls/${number}`) : ctx.entity ?? github.get(`/repos/${owner}/${repo}/issues/${number}`),
    listComments(),
    isPR ? github.paginate(`/repos/${owner}/${repo}/pulls/${number}/comments`, { max: 300, total: ctx.payload?.pull_request?.review_comments ?? 0 }) : [],
  ]);
  const L = [`# ${isPR ? 'Pull request' : 'Issue'} #${number}: ${entity.title}`, '', `_opened by @${entity.user?.login} · state ${entity.state}_`, '', entity.body || '_(no description)_'];
  const mine = await own(comments);
  const ours = (c) => mine.has(c.id);
  const keep = (c) => c.user && keepCommentAuthor(c.user.login, inputs) && !ours(c);
  for (const c of comments) {
    if (c.id === currentCommentId) continue;
    // The agent's own earlier replies are part of the conversation.
    if (ours(c)) {
      if (!/is working…/.test(c.body ?? '')) L.push('', `## you (harness, earlier reply) · ${c.created_at}`, '', previousReply(c.body));
    } else if (keep(c)) {
      L.push('', `## @${c.user.login} · ${c.created_at}`, '', c.body ?? '');
    }
  }
  if (isPR) {
    const kept = reviews.filter(keep);
    if (kept.length) {
      L.push('', '# Review comments');
      for (const c of kept) L.push('', `## @${c.user.login} on \`${c.path}:${c.line ?? c.original_line ?? '?'}\``, '', c.body ?? '');
    }
  }
  return { markdown: L.join('\n'), entity };
}

async function ciStatus(github, ctx, sha) {
  try {
    const runs = await github.paginate(`/repos/${ctx.owner}/${ctx.repo}/commits/${sha}/check-runs`, { max: 100 });
    return runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url, summary: r.output?.summary ? truncate(r.output.summary, 500) : undefined }));
  } catch (err) {
    core.info(`CI status unavailable (${err.status ?? err.message}); grant \`checks: read\` / \`actions: read\` to enable get_ci_status.`);
    return null;
  }
}

/** Throws on what the inputs alone show cannot work. */
export function validateRun({ adapter, model, endpoint, inputs, workDir }) {
  adapter.validate?.({ model, endpoint });
  if (inputs.skill && !inputs.skills.length && !repositorySkillNames(workDir).includes(inputs.skill)) {
    throw new Error(`Input skill "${inputs.skill}" is not installed: no \`skills\` source is given and the repository has no skill of that name (in ${['.agents', '.claude', '.opencode', '.codex', '.pi', '.openclaw'].map((d) => `${d}/skills`).join(', ')})`);
  }
}

export async function prepare({ env = process.env, stateDir, toolsDir }) {
  const inputs = readInputs(env);
  const ctx = readContext(env);
  // Real path: OpenCode 2 keys MCP tools by directory and resolves symlinks (/var → /private/var
  // on macOS), so a symlinked working directory would get no MCP tools at all.
  const workDirRaw = path.resolve(env.GITHUB_WORKSPACE || process.cwd(), inputs.workingDirectory);
  const workDir = fs.existsSync(workDirRaw) ? fs.realpathSync(workDirRaw) : workDirRaw;
  fs.mkdirSync(stateDir, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(stateDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

  const modeInfo = detectMode(ctx, inputs);
  const base = { mode: modeInfo.mode, reason: modeInfo.reason, harness: inputs.harness, model: inputs.model, workDir };
  if (modeInfo.mode === 'skip') {
    core.notice(`harness-action: nothing to do — ${modeInfo.reason}.`);
    save('context.json', { ...base, run: false });
    return { run: false, mode: 'skip' };
  }
  if (!inputs.model) throw new Error('Input required and not supplied: model (provider/model, e.g. anthropic/claude-sonnet-5-5)');

  const github = createClient({ token: inputs.githubToken });
  const access = await checkAccess(ctx, inputs, modeInfo.mode, github, { author: modeInfo.author });
  if (!access.allowed) {
    core.notice(`harness-action: not running — ${access.reason}.`);
    save('context.json', { ...base, run: false, mode: 'skip', reason: access.reason });
    return { run: false, mode: 'skip' };
  }
  core.info(`Mode: ${modeInfo.mode} (${modeInfo.reason}); ${access.reason}.`);
  const unchecked = inputs.jsonSchema ? uncheckedKeywords(inputs.jsonSchema) : [];
  if (unchecked.length) core.warning(`json_schema uses keywords this action does not validate: ${unchecked.join(', ')}. The structured output is checked against the rest of the schema only.`);

  const { adapter, adapterId, meta, version } = resolveHarness(inputs.harness, inputs.harnessVersion);
  const thread0 = sessionThread(inputs, ctx, modeInfo.mode);
  // Tag mode answers questions (read-only, with recommendations) and changes code only when
  // asked to. An explicit `tools` input always wins.
  const intent = intentFor(modeInfo, inputs);
  const tools = intent === 'ask' && inputs.tools === 'auto' ? 'read-only' : effectiveTools(inputs.tools, modeInfo.mode);
  const loop = intent === 'ask' && tools === 'read-only' ? { maxIterations: 1, until: '' } : loopSettings(inputs);
  core.info(`Intent: ${intent === 'ask' ? 'answer (read-only, recommendations)' : 'act'} · tools: ${tools}.`);
  const perms = permissionProfile(tools, inputs.allowBash);
  const model = { ...splitModel(inputs.model), raw: inputs.model };
  const endpoint = resolveEndpoint({ provider: model.provider, baseUrl: inputs.baseUrl, apiKeyEnv: inputs.apiKeyEnv });
  const isPR = ctx.isPR;
  // Mistakes in the inputs are reported now, before a tracking comment is posted and the harness
  // is installed: only what depends on a clone (a skill from `skills`) is left for later.
  validateRun({ adapter, model, endpoint, inputs, workDir });

  const own = ownComments(github);
  const listComments = commentLister(github, ctx);

  // --- tracking comment ----------------------------------------------------------------------
  let trackingCommentId = null;
  const tracking = wantsTrackingComment(ctx, inputs, modeInfo.mode) || (modeInfo.mode === 'automation' && inputs.postComment && ctx.number);
  const sticky = inputs.useStickyComment || (modeInfo.mode === 'automation' && inputs.postComment) ? stickyMarker(inputs.harness) : null;
  if (tracking) {
    if (ctx.comment?.id && ctx.eventName !== 'pull_request_review_comment') {
      github.post(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${ctx.comment.id}/reactions`, { content: 'eyes' }).catch(() => {});
    } else if (ctx.comment?.id) {
      github.post(`/repos/${ctx.owner}/${ctx.repo}/pulls/comments/${ctx.comment.id}/reactions`, { content: 'eyes' }).catch(() => {});
    }
    const body = workingBody({ harness: inputs.harness, model: inputs.model, runUrl: ctx.runUrl, sticky });
    try {
      if (sticky) {
        const comments = await listComments();
        const mine = await own(comments);
        const existing = comments.find((c) => c.body?.includes(sticky) && mine.has(c.id));
        if (existing) { await github.patch(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`, { body }); trackingCommentId = existing.id; }
      }
      if (!trackingCommentId) trackingCommentId = (await github.post(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`, { body })).id;
      core.info(`Tracking comment: ${trackingCommentId}`);
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      // A comment is a nicety: without `issues: write` / `pull-requests: write`, report in the job summary.
      core.warning(`Cannot comment on #${ctx.number} (${err.status}): grant \`issues: write\` and \`pull-requests: write\` for the tracking comment. The result goes to the job summary.`);
    }
  }

  try {
    // --- pull request data + checkout of the right branch --------------------------------------
    let pr = null;
    let changedFiles = [];
    let thread = null;
    if (ctx.number && (modeInfo.mode === 'tag' || isPR)) {
      const t = await buildThread({ github, ctx, inputs, isPR, currentCommentId: trackingCommentId, own, listComments });
      thread = t.markdown;
      save('thread.md', thread);
      if (isPR) {
        const p = t.entity;
        pr = { number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseRef: p.base.ref, baseSha: p.base.sha, isFork: p.head.repo?.full_name !== p.base.repo?.full_name, headRepo: p.head.repo?.full_name };
        const [diff, files] = await Promise.all([
          github.get(`/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}`, { accept: 'application/vnd.github.v3.diff', raw: true }).catch((err) => {
            // (GitHub refuses the diff of a very large pull request with a 406)
            core.warning(`Cannot fetch the diff of #${ctx.number} (${err.message}): get_pr_diff will be empty and review comments will be listed in the reply instead of on the lines.`);
            return '';
          }),
          github.paginate(`/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/files`, { max: 300 }),
        ]);
        save('pr.diff', diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n…diff truncated…\n' : diff);
        changedFiles = files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
      }
    }

    // --- conversation: restored here from an artifact, or just before this step from the cache --
    // (the cache store: `resolve` emptied the directory and a step of action.yml filled it)
    const sessionDir = env.HARNESS_SESSION_DIR || path.join(env.RUNNER_TEMP || stateDir, 'harness-action-session');
    const alreadyRestored = Boolean(env.HARNESS_SESSION_KEEP) || inputs.sessionStore === 'cache';
    let savedBranch = '';
    if (thread0) {
      if (!alreadyRestored) fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      core.info(`Conversation: ${thread0}.`);
      if (!alreadyRestored) {
        const r = await restoreSessionArtifact({ github, owner: ctx.owner, repo: ctx.repo, name: sessionArtifactName(adapterId, thread0), dir: sessionDir, tmpDir: stateDir })
          .catch((err) => ({ restored: false, reason: `could not restore it: ${err.message}` }));
        if (r.restored || /no saved/.test(r.reason)) core.info(`Saved conversation: ${r.reason}.`);
        else core.warning(`Saved conversation: ${r.reason}.`);
      }
      try { savedBranch = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')).branch ?? ''; } catch {}
      const trusted = conversationBranch(savedBranch, { defaultBranch: ctx.defaultBranch, baseBranch: inputs.baseBranch, prefix: inputs.branchPrefix, template: inputs.branchNameTemplate });
      if (savedBranch && !trusted) core.warning(`The saved conversation names the branch "${truncate(String(savedBranch), 100)}", which is not a branch this action creates: starting a new one.`);
      savedBranch = trusted;
    }

    // Commit target decided now, so the right branch is checked out before credentials go away.
    let commitMode = inputs.commitMode;
    if (commitMode === 'auto') commitMode = modeInfo.mode === 'tag' ? (isPR ? 'pr-branch' : 'new-branch') : inputs.openPr ? 'new-branch' : 'none';
    if (!perms.edit) commitMode = 'none';
    // An issue conversation keeps working on the branch it created in an earlier turn.
    let targetBranch = '';
    if (commitMode === 'new-branch' && savedBranch && !isPR && isRepo(workDir)) {
      try {
        git(['fetch', '--no-tags', '--depth', '50', 'origin', `+refs/heads/${savedBranch}:refs/remotes/origin/${savedBranch}`], workDir);
        git(['checkout', '-B', savedBranch, `origin/${savedBranch}`], workDir);
        commitMode = 'continue-branch';
        targetBranch = savedBranch;
        core.info(`Continuing on ${savedBranch}, the branch of this conversation.`);
      } catch {
        core.info(`The conversation's branch ${savedBranch} is gone: starting a new one.`);
      }
    }
    if (commitMode === 'pr-branch' && (!pr || pr.isFork)) {
      core.warning(pr?.isFork ? 'The pull request comes from a fork: changes cannot be pushed to it; they are saved as a patch.' : 'commit_mode pr-branch needs a pull request; changes are saved as a patch.');
      commitMode = 'none';
    }
    // The action never commits to the default branch, even when it is the head of a pull request.
    if (commitMode === 'pr-branch' && ctx.defaultBranch && pr.headRef === ctx.defaultBranch) {
      core.warning(`The head of this pull request is the default branch (${pr.headRef}): the action does not commit to it; changes are saved as a patch.`);
      commitMode = 'none';
    }
    const repoOk = isRepo(workDir);
    if (!repoOk && commitMode !== 'none') { core.warning(`${workDir} is not a git checkout: changes cannot be committed.`); commitMode = 'none'; }
    const checkout = repoOk ? prCheckout({ pr, commitMode, eventName: ctx.eventName, atHead: headSha(workDir) === pr?.headSha }) : null;
    if (checkout) {
      core.info(`Checking out ${pr.headRef} (${pr.headSha.slice(0, 7)})`);
      try {
        git(['fetch', '--no-tags', '--depth', '50', 'origin', `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`], workDir);
        git(['checkout', '-B', pr.headRef, `origin/${pr.headRef}`], workDir);
      } catch (err) {
        if (checkout === 'required') throw err;
        core.warning(`Cannot check out ${pr.headRef}: the agent reads the pull request through its diff only. (${truncate(String(err.stderr || err.message).trim(), 300)})`);
      }
    }
    // Does the working tree hold the pull request's code? (a `pull_request*` event is checked
    // out on its merge commit, except `pull_request_target`, which gets the base branch; a
    // comment on a fork's pull request stays on the default branch)
    const prCode = pr ? headSha(workDir) === pr.headSha || (ctx.eventName.startsWith('pull_request') && ctx.eventName !== 'pull_request_target') : false;
    if (repoOk && commitMode === 'new-branch' && inputs.baseBranch) {
      git(['fetch', '--no-tags', '--depth', '50', 'origin', `+refs/heads/${inputs.baseBranch}:refs/remotes/origin/${inputs.baseBranch}`], workDir);
      git(['checkout', '-B', inputs.baseBranch, `origin/${inputs.baseBranch}`], workDir);
    }

    const ci = await ciStatus(github, ctx, pr?.headSha ?? ctx.sha);
    if (ci) save('ci.json', ci);

    // --- harness, skills, MCP --------------------------------------------------------------------
    const home = path.join(stateDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), '[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n');
    const bin = await core.group(`Install ${inputs.harness}@${String(version).slice(0, 12)}`, () => adapter.install({ version, toolsDir, log: core.info, meta }));
    const skills = await core.group('Install skills', () => {
      const list = installSkills({ sources: inputs.skills, home, workDir, token: inputs.skillsToken || inputs.githubToken, tmpDir: stateDir, log: core.info });
      for (const s of list) core.info(`• ${s.name} (${s.source})`);
      if (!list.length) core.info('No skills.');
      return list;
    });
    if (inputs.skill && !skills.some((s) => s.name === inputs.skill)) throw new Error(`Input skill "${inputs.skill}" is not installed (installed: ${skills.map((s) => s.name).join(', ') || 'none'})`);

    const mcpState = { isPR: Boolean(pr), ciStatus: Boolean(ci), schema: inputs.jsonSchema ?? null, loop: loop.maxIterations > 1 && !loop.until };
    save('mcp.json', mcpState);
    const mcpToolNames = toolDefinitions(mcpState).map((t) => t.name);
    const mcpServers = { ...(inputs.mcpConfig ?? {}), harness: { command: process.execPath, args: [MCP_SERVER], env: { HARNESS_STATE: stateDir } } };
    const warn = (m) => core.warning(m);
    const prepared = adapter.prepare({ home, stateDir, workDir, model, endpoint, perms, mcpServers, mcpToolNames, harnessConfig: inputs.harnessConfig, warn });
    const reportDir = path.join(stateDir, 'report');
    fs.mkdirSync(path.join(reportDir, 'config'), { recursive: true });
    for (const [name, content] of Object.entries(prepared.files ?? {})) fs.writeFileSync(path.join(reportDir, 'config', name), redactMcpSecrets(content, inputs.mcpConfig));

    // --- prompt ---------------------------------------------------------------------------------
    const triggerComment = ctx.eventName === 'pull_request_review_comment' ? { path: ctx.comment?.path, line: ctx.comment?.line, diffHunk: ctx.comment?.diff_hunk } : null;
    const promptArgs = {
      intent,
      targetBranch,
      loop,
      harness: inputs.harness,
      mode: modeInfo.mode,
      ctx,
      perms,
      skills,
      skill: inputs.skill,
      request: modeInfo.mode === 'tag' ? modeInfo.triggerText : inputs.prompt,
      extraInstructions: modeInfo.mode === 'tag' ? inputs.prompt : '',
      pr,
      prCode,
      changedFiles,
      thread: thread && thread.length < 30_000 ? thread : thread ? '(long conversation: read it with the read_thread tool)' : null,
      triggerComment,
      isPR: Boolean(pr),
      ciStatus: Boolean(ci),
      schema: inputs.jsonSchema,
      allowBash: inputs.allowBash,
      commitMode,
      openPr: inputs.openPr,
    };
    save('prompt.md', buildPrompt(promptArgs));
    // A resumed session already knows the setup: it only gets the new message.
    save('followup.md', buildFollowupPrompt(promptArgs));
    fs.copyFileSync(path.join(stateDir, 'prompt.md'), path.join(reportDir, 'prompt.md'));


    // --- remove persisted git credentials for the agent run --------------------------------------
    const removedCredentials = repoOk ? stripCredentials(workDir) : null;
    if (removedCredentials?.headers.length || removedCredentials?.includes.length) core.info('Persisted git credentials removed for the agent run (restored afterwards).');

    // Token-free plan for the run stage.
    save('plan.json', {
      harness: inputs.harness,
      adapterId,
      loop,
      session: { enabled: Boolean(thread0), dir: thread0 ? sessionDir : '', thread: thread0 },
      version,
      bin,
      workDir,
      home,
      stateDir,
      env: prepared.env ?? {},
      extraArgs: splitArgs(inputs.harnessArgs),
      limits: { maxSteps: inputs.maxSteps, timeoutMinutes: inputs.timeoutMinutes, budgetUsd: inputs.budgetUsd },
      showFullOutput: inputs.showFullOutput,
      prepared: { ...prepared, files: undefined },
    });
    save('context.json', {
      ...base,
      run: true,
      version,
      tools,
      commitMode,
      trackingCommentId,
      sticky,
      pr,
      ctx: { eventName: ctx.eventName, action: ctx.action, owner: ctx.owner, repo: ctx.repo, number: ctx.number, isPR: Boolean(pr), actor: ctx.actor, actorId: ctx.payload.sender?.id ?? null, runUrl: ctx.runUrl, serverUrl: ctx.serverUrl, sha: ctx.sha, defaultBranch: ctx.defaultBranch, title: ctx.entity?.title ?? '' },
      request: modeInfo.mode === 'tag' ? modeInfo.triggerText : inputs.prompt,
      baseHead: repoOk ? headSha(workDir) : '',
      branchName: repoOk ? (git(['rev-parse', '--abbrev-ref', 'HEAD'], workDir).trim()) : '',
      removedCredentials,
      skills: skills.map((s) => ({ name: s.name, source: s.source })),
      adapterId,
      loop,
      session: { thread: thread0, dir: thread0 ? sessionDir : '', store: inputs.sessionStore },
      intent,
      targetBranch,
      openPr: inputs.openPr,
      jsonSchema: inputs.jsonSchema,
    });
    return {
      run: true,
      mode: modeInfo.mode,
    };
  } catch (err) {
    // The tracking comment must not stay "working…" forever.
    if (trackingCommentId) {
      await github.patch(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${trackingCommentId}`, {
        body: `${TRACKING_MARKER}\n${sticky ?? ''}\n❌ **${inputs.harness}** could not start · [View job run](${ctx.runUrl})\n\n> ${truncate(err.message, 1000)}`,
      }).catch(() => {});
    }
    throw err;
  }
}
