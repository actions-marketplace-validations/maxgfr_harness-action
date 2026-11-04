// Minimal GitHub REST + GraphQL client on top of fetch.
export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createClient({ token, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com', graphqlUrl = process.env.GITHUB_GRAPHQL_URL } = {}) {
  const gql = graphqlUrl || `${apiUrl.replace(/\/$/, '')}/graphql`;
  const headers = (extra = {}) => ({
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'harness-action',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function request(method, path, body, { accept, raw = false, binary = false, retries = 2 } = {}) {
    const url = path.startsWith('http') ? path : `${apiUrl.replace(/\/$/, '')}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: headers({ ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }),
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      // (redirects are followed; fetch drops the Authorization header on a cross-origin hop,
      // e.g. to the artifact blob storage)
      if (binary && res.ok) return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { msg = JSON.parse(text).message ?? text; } catch {}
        throw new GitHubError(res.status, `${method} ${path} → ${res.status}: ${msg}`, text);
      }
      if (raw) return text;
      return text ? JSON.parse(text) : null;
    }
  }

  async function paginate(path, { max = 1000 } = {}) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; out.length < max; page++) {
      const batch = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const items = Array.isArray(batch) ? batch : batch?.items ?? batch?.check_runs ?? batch?.workflow_runs ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out.slice(0, max);
  }

  async function graphql(query, variables = {}) {
    const res = await fetch(gql, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors?.length) {
      throw new GitHubError(res.status, `GraphQL: ${json.errors?.map((e) => e.message).join('; ') || res.statusText}`, json);
    }
    return json.data;
  }

  return {
    request,
    paginate,
    graphql,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
  };
}
