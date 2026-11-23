// Release cooldown for the harness bump: adopt a release only once it has been public for a while,
// so a compromised publish has time to be noticed and pulled before it is pinned.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/; // no prerelease tag, no build metadata
const DAY = 86_400_000;

/** Numeric order of two stable versions (2.10.0 > 2.9.0). */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => STABLE.exec(v).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The highest stable version published at least `minAgeDays` before `now` (0 disables the
 * cooldown), or null. `times` is `npm view <pkg> time --json`: version → ISO date, plus the
 * `created` / `modified` keys, which are not versions. With `current`, only a newer version
 * counts: null then means "keep the pinned one", never a downgrade.
 */
export function pickVersion(times, { now = Date.now(), minAgeDays = 3, current } = {}) {
  const cutoff = now - minAgeDays * DAY;
  let best = null;
  for (const [version, at] of Object.entries(times ?? {})) {
    if (!STABLE.test(version)) continue;
    if (minAgeDays > 0 && !(Date.parse(at) <= cutoff)) continue;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  if (best && current && STABLE.test(current) && compareVersions(best, current) <= 0) return null;
  return best;
}

/** `--min-age-days N` (or `=N`), then MIN_RELEASE_AGE_DAYS, then 3. */
export function minAgeDaysFrom(argv, env) {
  const i = argv.findIndex((a) => a === '--min-age-days' || a.startsWith('--min-age-days='));
  const raw = i < 0 ? env.MIN_RELEASE_AGE_DAYS : argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  if (raw === undefined || raw === '') return 3;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) throw new Error(`min release age must be a number of days >= 0, got "${raw}"`);
  return days;
}
