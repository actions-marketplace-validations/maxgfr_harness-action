// Stage 1 (holds the GitHub token): decide whether to run, gather context, install everything,
// write a token-free plan for the run stage.
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../core/action.mjs';
import { readInputs, effectiveTools, splitModel, loopSettings, sessionThread, sessionCachePrefix, sessionArtifactName } from '../inputs.mjs';
import { restoreSessionArtifact } from '../github/session-store.mjs';
import { readContext } from '../github/context.mjs';
import { createClient } from '../github/api.mjs';
import { detectMode, checkAccess, wantsTrackingComment, keepCommentAuthor, classifyIntent } from '../modes.mjs';
import { resolveHarness, permissionProfile, MCP_SERVER, splitArgs } from '../harness/index.mjs';
import { resolveEndpoint } from '../harness/providers.mjs';
import { installSkills } from '../skills.mjs';
import { buildPrompt, buildFollowupPrompt } from '../prompt.mjs';
import { git, isRepo, headSha, stripCredentials } from '../git.mjs';
import { TRACKING_MARKER, stickyMarker, workingBody } from '../publish/render.mjs';
import { truncate } from '../util.mjs';
import { toolDefinitions } from '../mcp/server.mjs';

const MAX_DIFF = 2 * 1024 * 1024;

/** A previous reply of the agent, reduced to what it said (markers, spinner and footer removed). */
export function previousReply(body) {
  return String(body)
    .replace(/<!-- harness-action:[^>]*-->\n?/g, '')
    .replace(/\n<sub>.*<\/sub>\s*$/s, '')
    .trim();
}

async function buildThread({ github, ctx, inputs, isPR, currentCommentId }) {
  const { owner, repo, number } = ctx;
  const entity = isPR ? await github.get(`/repos/${owner}/${repo}/pulls/${number}`) : ctx.entity ?? (await github.get(`/repos/${owner}/${repo}/issues/${number}`));
  const comments = await github.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, { max: 300 });
  const L = [`# ${isPR ? 'Pull request' : 'Issue'} #${number}: ${entity.title}`, '', `_opened by @${entity.user?.login} · state ${entity.state}_`, '', entity.body || '_(no description)_'];
  const ours = (c) => String(c.body ?? '').includes(TRACKING_MARKER) || String(c.body ?? '').includes('<!-- harness-action:sticky:');
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
    const reviews = await github.paginate(`/repos/${owner}/${repo}/pulls/${number}/comments`, { max: 300 });
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
  const access = await checkAccess(ctx, inputs, modeInfo.mode, github);
  if (!access.allowed) {
    core.notice(`harness-action: not running — ${access.reason}.`);
    save('context.json', { ...base, run: false, mode: 'skip', reason: access.reason });
    return { run: false, mode: 'skip' };
  }
  core.info(`Mode: ${modeInfo.mode} (${modeInfo.reason}); ${access.reason}.`);

  const { adapter, adapterId, meta, version } = resolveHarness(inputs.harness, inputs.harnessVersion);
  const thread0 = sessionThread(inputs, ctx, modeInfo.mode);
  // Tag mode answers questions (read-only, with recommendations) and changes code only when
  // asked to. An explicit `tools` input always wins.
  let intent = 'do';
  if (modeInfo.mode === 'tag' && inputs.askMode !== 'off') intent = inputs.askMode === 'always' ? 'ask' : classifyIntent(modeInfo.triggerText, inputs.triggerPhrase);
  const tools = intent === 'ask' && inputs.tools === 'auto' ? 'read-only' : effectiveTools(inputs.tools, modeInfo.mode);
  const loop = intent === 'ask' && tools === 'read-only' ? { maxIterations: 1, until: '' } : loopSettings(inputs);
  core.info(`Intent: ${intent === 'ask' ? 'answer (read-only, recommendations)' : 'act'} · tools: ${tools}.`);
  const perms = permissionProfile(tools, inputs.allowBash);
  const model = { ...splitModel(inputs.model), raw: inputs.model };
  const endpoint = resolveEndpoint({ provider: model.provider, baseUrl: inputs.baseUrl, apiKeyEnv: inputs.apiKeyEnv });
  const isPR = ctx.isPR;

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
        const existing = (await github.paginate(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`, { max: 500 })).find((c) => c.body?.includes(sticky));
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
      const t = await buildThread({ github, ctx, inputs, isPR, currentCommentId: trackingCommentId });
      thread = t.markdown;
      save('thread.md', thread);
      if (isPR) {
        const p = t.entity;
        pr = { number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseRef: p.base.ref, baseSha: p.base.sha, isFork: p.head.repo?.full_name !== p.base.repo?.full_name, headRepo: p.head.repo?.full_name };
        const diff = await github.get(`/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}`, { accept: 'application/vnd.github.v3.diff', raw: true }).catch(() => '');
        save('pr.diff', diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n…diff truncated…\n' : diff);
        changedFiles = (await github.paginate(`/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/files`, { max: 300 })).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
      }
    }

    // --- conversation: restored here from an artifact, or by the cache step that follows ---------
    const sessionDir = env.HARNESS_SESSION_DIR || path.join(env.RUNNER_TEMP || stateDir, 'harness-action-session');
    let savedBranch = '';
    if (thread0) {
      if (!env.HARNESS_SESSION_KEEP) fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      core.info(`Conversation: ${thread0}.`);
      if (inputs.sessionStore === 'artifact' && !env.HARNESS_SESSION_KEEP) {
        const r = await restoreSessionArtifact({ github, owner: ctx.owner, repo: ctx.repo, name: sessionArtifactName(adapterId, thread0), dir: sessionDir, tmpDir: stateDir })
          .catch((err) => ({ restored: false, reason: `could not restore it: ${err.message}` }));
        if (r.restored || /no saved/.test(r.reason)) core.info(`Saved conversation: ${r.reason}.`);
        else core.warning(`Saved conversation: ${r.reason}.`);
      }
      try { savedBranch = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8')).branch ?? ''; } catch {}
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
    const repoOk = isRepo(workDir);
    if (!repoOk && commitMode !== 'none') { core.warning(`${workDir} is not a git checkout: changes cannot be committed.`); commitMode = 'none'; }
    if (repoOk && commitMode === 'pr-branch' && headSha(workDir) !== pr.headSha) {
      core.info(`Checking out ${pr.headRef} (${pr.headSha.slice(0, 7)})`);
      git(['fetch', '--no-tags', '--depth', '50', 'origin', `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`], workDir);
      git(['checkout', '-B', pr.headRef, `origin/${pr.headRef}`], workDir);
    }
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
    for (const [name, content] of Object.entries(prepared.files ?? {})) fs.writeFileSync(path.join(reportDir, 'config', name), content);

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
    });
    return {
      run: true,
      mode: modeInfo.mode,
      sessionDir: thread0 ? sessionDir : '',
      sessionRestorePrefix: thread0 && inputs.sessionStore === 'cache' ? sessionCachePrefix(adapterId, thread0) : '',
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
