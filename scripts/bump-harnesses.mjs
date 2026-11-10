#!/usr/bin/env node
// Bump the pinned harness versions to their latest npm releases.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = new URL('../src/harness/versions.json', import.meta.url);
const versions = JSON.parse(fs.readFileSync(file, 'utf8'));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const changes = [];
for (const [id, meta] of Object.entries(versions)) {
  const latest = sh('npm', ['view', meta.package, 'version']);
  if (latest && latest !== meta.version) {
    changes.push(`${id}: ${meta.version} → ${latest}`);
    meta.version = latest;
  }
}
fs.writeFileSync(file, JSON.stringify(versions, null, 2) + '\n');
console.log(changes.length ? changes.join('\n') : 'All harnesses are up to date.');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes<<EOF\n${changes.join('\n')}\nEOF\n`);
