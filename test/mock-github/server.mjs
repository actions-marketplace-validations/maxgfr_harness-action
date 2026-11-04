// In-memory mock of the GitHub REST + GraphQL endpoints the action uses. Records every call.
import http from 'node:http';

export function createGitHubMock({ owner = 'acme', repo = 'demo', pr = null, issue = null, diff = '', permission = 'write' } = {}) {
  const calls = [];
  const artifacts = []; // { id, name, created_at, expired, data: Buffer }
  const comments = new Map(); // id → {id, body, user}
  let nextId = 1000;
  const base = `/repos/${owner}/${repo}`;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      calls.push({ method: req.method, path: p, body, auth: req.headers.authorization ?? null });
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      let m;

      if (req.method === 'POST' && p === '/graphql') {
        const input = body.variables?.input;
        // like GitHub: the job token cannot change workflow files
        const fc = input?.fileChanges ?? {};
        if ([...(fc.additions ?? []), ...(fc.deletions ?? [])].some((f) => /^\.github\/workflows\//.test(f.path))) {
          return json(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
        }
        return json(200, { data: { createCommitOnBranch: { commit: { oid: 'c0ffee0000000000000000000000000000000001', url: `https://github.com/${owner}/${repo}/commit/c0ffee1`, input } } } });
      }
      if ((m = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(p))) return json(200, { permission, role_name: permission, user: { login: m[1] } });
      if ((m = /\/issues\/(\d+)\/comments$/.exec(p))) {
        if (req.method === 'POST') { const c = { id: nextId++, body: body.body, user: { login: 'github-actions[bot]' }, created_at: new Date().toISOString() }; comments.set(c.id, c); return json(201, c); }
        return json(200, [...comments.values()]);
      }
      if ((m = /\/issues\/comments\/(\d+)$/.exec(p)) && req.method === 'PATCH') {
        const c = comments.get(Number(m[1])) ?? { id: Number(m[1]), user: { login: 'github-actions[bot]' } };
        c.body = body.body; comments.set(c.id, c); return json(200, c);
      }
      if (/\/reactions$/.test(p)) return json(201, { id: 1, content: body?.content });
      if ((m = /\/issues\/(\d+)$/.exec(p))) return issue ? json(200, issue) : json(404, { message: 'Not Found' });
      if (pr && p === `${base}/pulls/${pr.number}`) {
        if ((req.headers.accept ?? '').includes('diff')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(diff); }
        return json(200, pr);
      }
      if (pr && p === `${base}/pulls/${pr.number}/files`) return json(200, [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0 }]);
      if (pr && p === `${base}/pulls/${pr.number}/comments`) return json(200, []);
      if (pr && p === `${base}/pulls/${pr.number}/reviews` && req.method === 'POST') return json(200, { id: 77, state: 'COMMENTED' });
      if (/\/commits\/[^/]+\/check-runs$/.test(p)) return json(200, { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://example/check' }] });
      if (p === `${base}/git/refs` && req.method === 'POST') return json(201, { ref: body.ref, object: { sha: body.sha } });
      if (p === `${base}/actions/artifacts` && req.method === 'GET') {
        const name = url.searchParams.get('name');
        return json(200, { total_count: artifacts.length, artifacts: artifacts.filter((a) => !name || a.name === name).map(({ data, ...a }) => ({ ...a, archive_download_url: `http://${req.headers.host}${base}/actions/artifacts/${a.id}/zip` })) });
      }
      if ((m = /\/actions\/artifacts\/(\d+)\/zip$/.exec(p))) {
        const a = artifacts.find((x) => x.id === Number(m[1]));
        if (!a) return json(404, { message: 'Not Found' });
        res.writeHead(200, { 'content-type': 'application/zip' });
        return res.end(a.data);
      }
      if (p === `${base}/pulls` && req.method === 'POST') return json(201, { number: 21, html_url: `https://github.com/${owner}/${repo}/pull/21`, head: { ref: body.head }, base: { ref: body.base } });
      json(404, { message: `mock: no route for ${req.method} ${p}` });
    });
  });
  const addArtifact = (name, data) => artifacts.push({ id: artifacts.length + 1, name, created_at: new Date(Date.now() + artifacts.length).toISOString(), expired: false, workflow_run: { id: 100 + artifacts.length }, data });
  return { server, calls, comments, addArtifact };
}
