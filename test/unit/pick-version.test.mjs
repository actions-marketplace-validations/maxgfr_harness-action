import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVersion, compareVersions, minAgeDaysFrom } from '../../scripts/lib/pick-version.mjs';

const now = Date.parse('2026-11-23T12:00:00Z');
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

test('pickVersion skips prereleases', () => {
  const times = { '2.1.0': daysAgo(10), '2.2.0-beta.1': daysAgo(9), '3.0.0-rc.1': daysAgo(8), '0.0.0-dev-1': daysAgo(7) };
  assert.equal(pickVersion(times, { now }), '2.1.0');
});

test('pickVersion skips releases younger than the cooldown', () => {
  const times = { '2.1.0': daysAgo(10), '2.2.0': daysAgo(3), '2.3.0': daysAgo(2.9) };
  assert.equal(pickVersion(times, { now }), '2.2.0'); // exactly 3 days old is old enough
  assert.equal(pickVersion(times, { now, minAgeDays: 7 }), '2.1.0');
  assert.equal(pickVersion({ '2.3.0': daysAgo(1) }, { now }), null);
});

test('pickVersion orders versions numerically, not by date or string', () => {
  const times = { '2.10.0': daysAgo(20), '2.9.0': daysAgo(5), '10.0.0': daysAgo(30), '9.99.99': daysAgo(4) };
  assert.equal(pickVersion(times, { now }), '10.0.0');
  assert.equal(pickVersion({ '2.10.0': daysAgo(20), '2.9.0': daysAgo(5) }, { now }), '2.10.0');
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
  assert.ok(compareVersions('2026.11.6', '2026.10.33') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('pickVersion never downgrades the pinned version', () => {
  const times = { '2.1.0': daysAgo(10), '2.2.0': daysAgo(5), '2.3.0': daysAgo(1) };
  assert.equal(pickVersion(times, { now, current: '2.3.0' }), null); // pinned is newer than anything eligible
  assert.equal(pickVersion(times, { now, current: '2.2.0' }), null); // same version: nothing to change
  assert.equal(pickVersion(times, { now, current: '2.1.0' }), '2.2.0');
});

test('pickVersion with minAgeDays 0 disables the cooldown', () => {
  const times = { '2.1.0': daysAgo(10), '2.2.0': daysAgo(0), '2.3.0-beta.1': daysAgo(0) };
  assert.equal(pickVersion(times, { now, minAgeDays: 0 }), '2.2.0');
});

test('pickVersion ignores the created / modified keys', () => {
  const times = { created: daysAgo(100), modified: daysAgo(50), '1.0.0': daysAgo(40) };
  assert.equal(pickVersion(times, { now }), '1.0.0');
  assert.equal(pickVersion({ created: daysAgo(100), modified: daysAgo(50) }, { now }), null);
});

test('minAgeDaysFrom: flag, then env, then 3', () => {
  assert.equal(minAgeDaysFrom([], {}), 3);
  assert.equal(minAgeDaysFrom([], { MIN_RELEASE_AGE_DAYS: '7' }), 7);
  assert.equal(minAgeDaysFrom(['--min-age-days', '0'], { MIN_RELEASE_AGE_DAYS: '7' }), 0);
  assert.equal(minAgeDaysFrom(['--lock', '--min-age-days=5'], {}), 5);
  assert.throws(() => minAgeDaysFrom(['--min-age-days', 'soon'], {}), /number of days/);
  assert.throws(() => minAgeDaysFrom([], { MIN_RELEASE_AGE_DAYS: '-1' }), /number of days/);
});
