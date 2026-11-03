// What triggered this run, normalised.
import fs from 'node:fs';

export function readContext(env = process.env) {
  let payload = {};
  if (env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  }
  const [owner = '', repo = ''] = (env.GITHUB_REPOSITORY || '').split('/');
  const eventName = env.GITHUB_EVENT_NAME || '';
  const issue = payload.issue;
  const pr = payload.pull_request;
  const isPR = Boolean(pr || issue?.pull_request);
  const number = pr?.number ?? issue?.number ?? payload.number ?? null;
  const comment = payload.comment ?? null;
  const review = payload.review ?? null;
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';

  return {
    eventName,
    action: payload.action ?? '',
    payload,
    owner,
    repo,
    repoFull: `${owner}/${repo}`,
    actor: env.GITHUB_ACTOR || payload.sender?.login || '',
    senderType: payload.sender?.type || '',
    number,
    isPR,
    isIssue: Boolean(issue && !issue.pull_request),
    entity: pr ?? issue ?? null,
    comment,
    review,
    defaultBranch: payload.repository?.default_branch || '',
    sha: env.GITHUB_SHA || '',
    ref: env.GITHUB_REF || '',
    runUrl: `${serverUrl}/${owner}/${repo}/actions/runs/${env.GITHUB_RUN_ID || ''}`,
    serverUrl,
    runId: env.GITHUB_RUN_ID || '',
    isFork: Boolean(pr && pr.head?.repo && pr.base?.repo && pr.head.repo.full_name !== pr.base.repo.full_name),
  };
}
