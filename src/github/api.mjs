// Minimal GitHub REST + GraphQL client on top of fetch.
export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createClient({ token, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com', graphqlUrl = process.env.GITHUB_GRAPHQL_URL, retryDelayMs = 1000, timeoutMs = 60_000 } = {}) {
  const backoff = (attempt) => new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
  // No request waits for ever: a connection that hangs would hold the step until the job timeout.
  const deadline = (ms = timeoutMs) => AbortSignal.timeout(ms);
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
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: headers({ ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }),
          body: body ? JSON.stringify(body) : undefined,
          signal: deadline(binary ? timeoutMs * 5 : timeoutMs), // (a download gets longer)
        });
      } catch (err) {
        // A dropped or stalled connection. Only a read is retried: a write may have reached GitHub.
        if (method !== 'GET' || attempt >= retries) throw err;
        await backoff(attempt);
        continue;
      }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await backoff(attempt);
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

  /**
   * Every page of a list, up to `max` items. When the list is longer than `max` and `total` (its
   * known length) is given, the NEWEST `max` items are returned instead of the oldest: the pages
   * before them are not even requested.
   */
  async function paginate(path, { max = 1000, total = 0 } = {}) {
    const out = [];
    const sep = path.includes('?') ? '&' : '?';
    const fromEnd = total > max;
    for (let page = fromEnd ? Math.floor((total - max) / 100) + 1 : 1; ; page++) {
      const batch = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const items = Array.isArray(batch) ? batch : batch?.items ?? batch?.check_runs ?? batch?.workflow_runs ?? [];
      out.push(...items);
      if (items.length < 100 || (!fromEnd && out.length >= max)) break;
    }
    return fromEnd ? out.slice(-max) : out.slice(0, max);
  }

  async function graphql(query, variables = {}) {
    const res = await fetch(gql, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
      signal: deadline(timeoutMs * 5), // (a commit carries every changed file)
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
