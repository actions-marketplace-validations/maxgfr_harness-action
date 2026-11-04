// Conversations stored as workflow artifacts.
//
// Why not the Actions cache: since 2026-06-26 the cache is READ-ONLY for low-trust triggers on
// the default branch (issue_comment, pull_request_target, workflow_run), which are exactly the
// triggers of a conversation. Artifacts can be uploaded from any run, are found again through
// the REST API (needs `actions: read`), and do not depend on the ref a run belongs to.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function unzip(file, dir) {
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    execFileSync('python3', ['-I', '-m', 'zipfile', '-e', file, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

/**
 * Restores the newest artifact called `name` into `dir`.
 * @returns {{ restored: boolean, reason: string, artifact?: object }}
 */
export async function restoreSessionArtifact({ github, owner, repo, name, dir, tmpDir }) {
  let list;
  try {
    list = await github.get(`/repos/${owner}/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=30`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      return { restored: false, reason: `cannot list artifacts (${err.status}): grant \`actions: read\` to the job to resume conversations` };
    }
    throw err;
  }
  const artifact = (list?.artifacts ?? [])
    .filter((a) => a.name === name && !a.expired)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!artifact) return { restored: false, reason: 'no saved conversation yet' };
  const zip = await github.request('GET', artifact.archive_download_url, undefined, { binary: true });
  const file = path.join(tmpDir, 'session.zip');
  fs.writeFileSync(file, zip);
  fs.mkdirSync(dir, { recursive: true });
  unzip(file, dir);
  fs.rmSync(file, { force: true });
  return { restored: true, reason: `restored from run ${artifact.workflow_run?.id ?? '?'} (${artifact.created_at})`, artifact };
}
