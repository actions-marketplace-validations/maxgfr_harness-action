#!/usr/bin/env node
// Bump the pinned harness versions to their newest stable npm releases published at least
// N days ago (the cooldown, 3 by default), and lock the dependencies of every pinned version
// (src/harness/locks/<harness>-<version>.json).
//   node scripts/bump-harnesses.mjs                     bump, then lock
//   node scripts/bump-harnesses.mjs --min-age-days N    cooldown of N days (or MIN_RELEASE_AGE_DAYS; 0 disables)
//   node scripts/bump-harnesses.mjs --lock              only (re)write the lockfiles of the pinned versions
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeLock, lockFile } from '../src/harness/install.mjs';
import { pickVersion, minAgeDaysFrom } from './lib/pick-version.mjs';

const file = new URL('../src/harness/versions.json', import.meta.url);
const versions = JSON.parse(fs.readFileSync(file, 'utf8'));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const lockOnly = process.argv.includes('--lock');
const minAgeDays = minAgeDaysFrom(process.argv.slice(2), process.env);
const changes = [];
for (const [id, meta] of Object.entries(versions)) {
  if (lockOnly) continue;
  // `time` keeps the dates of unpublished versions too: only the ones still listed count
  const { time, versions: listed } = JSON.parse(sh('npm', ['view', meta.package, 'time', 'versions', '--json']));
  const live = new Set([].concat(listed ?? []));
  const picked = pickVersion(Object.fromEntries(Object.entries(time ?? {}).filter(([v]) => live.has(v))), { minAgeDays, current: meta.version });
  if (picked) {
    changes.push(`${id}: ${meta.version} → ${picked} (published ${time[picked].slice(0, 10)})`);
    meta.version = picked;
  }
}
if (changes.length) fs.writeFileSync(file, `{\n${Object.entries(versions).map(([id, m]) => `  ${JSON.stringify(id)}: ${JSON.stringify(m).replace(/,/g, ', ').replace(/:/g, ': ').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`).join(',\n')}\n}\n`);

// one lockfile per pinned version; the ones of earlier versions go
const locks = path.dirname(lockFile('x', 'y'));
const wanted = new Set(Object.entries(versions).map(([id, meta]) => path.basename(lockFile(id, meta.version))));
for (const [id, meta] of Object.entries(versions)) {
  if (lockOnly || !fs.existsSync(lockFile(id, meta.version))) writeLock({ id, pkg: meta.package, version: meta.version, tmpDir: os.tmpdir() });
}
for (const name of fs.existsSync(locks) ? fs.readdirSync(locks) : []) if (!wanted.has(name)) fs.rmSync(path.join(locks, name));

console.log(changes.length ? changes.join('\n') : `All harnesses are up to date${minAgeDays && !lockOnly ? ` (releases younger than ${minAgeDays} days are not adopted yet)` : ''}.`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes<<EOF\n${changes.join('\n')}\nEOF\n`);
