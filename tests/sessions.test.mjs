import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionMonitor, compareQuota } from '../src/sessions.mjs';

const base = Date.UTC(2026, 9, 4, 8, 0);
const event = (type, extra = {}, at = base + 1000) => ({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, ...extra } });
const meta = (id = 'thread-one', account = 'account-one', extra = {}) => ({ type: 'session_meta', payload: { id, creator_account_id: account, timestamp: new Date(base - 10000).toISOString(), originator: 'Codex Desktop', ...extra } });
const usage = (input, output, cached = 0, extra = {}) => event('token_count', { info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }, last_token_usage: { input_tokens: 999, output_tokens: 999 } }, ...extra });
const start = (id = 'turn-one', at = base + 1000) => event('task_started', { turn_id: id, started_at: at / 1000 }, at);
const complete = (id = 'turn-one', extra = {}) => event('task_complete', { turn_id: id, completed_at: (base + 5000) / 1000, duration_ms: 4000, ...extra }, base + 5000);
const encoded = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const pause = () => new Promise(resolve => setTimeout(resolve, 30));

async function fixture(t, rows = [], options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dragon-session-test-'));
  const dir = path.join(home, 'sessions', '2026', '10', '04');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-test.jsonl');
  await fs.writeFile(file, encoded([meta(), ...rows]));
  const monitor = new SessionMonitor({ codexHome: home, expectedAccountId: 'account-one', pollIntervalMs: 0, settleMs: 10, now: () => base + 6000, ...options });
  // Test clock is fixed; only records added after start should complete at/after this point.
  const notices = [], active = [];
  monitor.on('notice', notice => notices.push(notice)); monitor.on('active', value => active.push(value));
  await monitor.start();
  monitor.startedAt = base;
  t.after(async () => { monitor.stop(); await fs.rm(home, { recursive: true, force: true }); });
  const append = async rows => { await fs.appendFile(file, encoded(rows)); await monitor.poll(); };
  return { home, dir, file, monitor, notices, active, append };
}

test('startup establishes counters and never replays old completion; repeated cumulative values count once', async t => {
  const f = await fixture(t, [usage(50, 10), start('old', base - 5000), usage(60, 15), complete('old')]);
  assert.equal(f.notices.length, 0);
  await f.append([start(), usage(160, 35, 40), usage(160, 35, 40), complete(), complete()]);
  await pause();
  assert.equal(f.notices.length, 1);
  assert.deepEqual(f.notices[0].tokens, { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, total_tokens: 120 });
  assert.equal(f.notices[0].kind, 'complete');
  assert.equal(f.monitor.snapshot.activeTurns, 0);
});

test('missing baseline remains unknown even when last_token_usage or first total are present', async t => {
  const f = await fixture(t);
  await f.append([start(), usage(500, 50), complete()]); await pause();
  assert.equal(f.notices[0].tokens, null);
  assert.match(f.notices[0].body, /基线不完整/);
});

test('counter rollback makes the entire turn unknown', async t => {
  const f = await fixture(t, [usage(500, 100)]);
  await f.append([start(), usage(550, 120), usage(10, 2), complete()]); await pause();
  assert.equal(f.notices[0].tokens, null);
});

test('settling accepts delayed counters without producing a second notice', async t => {
  const f = await fixture(t, [usage(100, 10)], { settleMs: 80 });
  await f.append([start(), usage(130, 12), complete()]);
  await f.append([usage(150, 16), complete()]);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].tokens.total_tokens, 56);
});

test('cancellation emits no completion; terminal errors are separate and redact their messages', async t => {
  const f = await fixture(t, [usage(100, 10)]);
  await f.append([start('cancel'), event('task_aborted', { turn_id: 'cancel' }), start('failed'), event('error', { turn_id: 'failed', message: 'PRIVATE CHAT AND PATH', will_retry: false }), complete('failed')]);
  await pause();
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'error');
  assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE|account-one|rollout-test/);
});

test('retrying stream errors keep a task active', async t => {
  const f = await fixture(t, [usage(100, 10)]);
  await f.append([start(), event('stream_error', { will_retry: true, message: 'private' })]);
  assert.equal(f.monitor.snapshot.activeTurns, 1); assert.equal(f.notices.length, 0);
});

test('unbound, mismatched account and subagent files are not monitored', async t => {
  const f = await fixture(t, [], { expectedAccountId: null });
  assert.equal(f.monitor.snapshot.status, 'unbound'); assert.equal(f.monitor.snapshot.observedFiles, 0);
  const g = await fixture(t, [usage(1, 1)]);
  await fs.writeFile(path.join(g.dir, 'rollout-other.jsonl'), encoded([meta('other', 'different-account'), start(), complete()]));
  await fs.writeFile(path.join(g.dir, 'rollout-subagent.jsonl'), encoded([meta('child', 'account-one', { source: { subagent: { thread_spawn: {} } } }), start(), complete()]));
  await g.monitor.poll(); await pause();
  assert.equal(g.monitor.snapshot.observedFiles, 1); assert.equal(g.notices.length, 0);
});

test('partial lines wait for newline; truncation and repeated turn IDs do not replay notices', async t => {
  const f = await fixture(t, [usage(10, 1)]);
  const first = JSON.stringify(start());
  await fs.appendFile(f.file, first.slice(0, 50)); await f.monitor.poll();
  assert.equal(f.monitor.snapshot.activeTurns, 0);
  await fs.appendFile(f.file, first.slice(50) + '\n' + encoded([usage(20, 2), complete()])); await f.monitor.poll(); await pause();
  assert.equal(f.notices.length, 1);
  await fs.writeFile(f.file, encoded([meta(), start(), complete()])); await f.monitor.poll(); await pause();
  assert.equal(f.notices.length, 1);
});

test('startup can recover an active turn without a start-time quota snapshot', async t => {
  const f = await fixture(t, [usage(10, 1), start(), usage(20, 2)]);
  assert.equal(f.monitor.snapshot.activeTurns, 1);
  await f.append([usage(40, 4), complete()]); await pause();
  assert.equal(f.notices[0].tokens.total_tokens, 33);
  assert.match(f.notices[0].body, /任务开始早于/);
  assert.deepEqual(f.notices[0].quotaChanges, []);
});

test('a long live task is recovered beyond the normal tail without inventing a token baseline', async t => {
  const padding = { type: 'response_item', payload: { type: 'message', content: 'PRIVATE-TEXT-'.repeat(80000) } };
  const f = await fixture(t, [usage(10, 1), start(), padding, usage(20, 2)]);
  assert.equal(f.monitor.snapshot.activeTurns, 1);
  await f.append([usage(40, 4), complete()]); await pause();
  assert.equal(f.notices[0].tokens, null);
  assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE-TEXT/);
});

const quota = (at, used = 6, reset = base + 86400000) => ({ observedAt: at, windows: [{ id: 'codex:primary', label: '每周', usedPercent: used, resetsAt: reset }] });
test('quota comparison rejects reset, regression and unchanged observedAt', () => {
  assert.deepEqual(compareQuota(quota(base), quota(base, 7)).changes, []);
  assert.match(compareQuota(quota(base), quota(base, 7)).note, /尚无新的/);
  assert.deepEqual(compareQuota(quota(base), quota(base + 1, 7, base + 100000)).changes, []);
  assert.deepEqual(compareQuota(quota(base), quota(base + 1, 5)).changes, []);
  assert.equal(compareQuota(quota(base), quota(base + 1, 7)).changes[0].usedPercentChange, 1);
  assert.deepEqual(compareQuota(null, quota(base)).changes, []);
});

test('simultaneous main tasks mark account changes as unassignable and stale samples stay unavailable', async t => {
  let snapshot = { identityVerified: true, status: 'ready', ...quota(base), windows: quota(base).windows.map(w => ({ ...w, status: 'fresh' })) };
  const f = await fixture(t, [usage(10, 1)], { getQuota: () => snapshot });
  await fs.writeFile(path.join(f.dir, 'rollout-second.jsonl'), encoded([meta('thread-two'), usage(10, 1)])); await f.monitor.poll();
  await f.append([start()]);
  await fs.appendFile(path.join(f.dir, 'rollout-second.jsonl'), encoded([start('turn-two')])); await f.monitor.poll();
  snapshot = { ...snapshot, status: 'stale', observedAt: base + 5000 };
  await f.append([usage(30, 3), complete()]); await pause();
  assert.match(f.notices[0].body, /并行主任务/); assert.deepEqual(f.notices[0].quotaChanges, []);
});

test('late counters explicitly assigned to an earlier turn cannot inflate the new turn', async t => {
  const f = await fixture(t, [usage(10, 1)]);
  await f.append([start('first'), usage(20, 2), complete('first'), start('second'), usage(30, 3, 0, { turn_id: 'first' }), usage(50, 5), complete('second')]);
  await pause();
  assert.equal(f.notices.length, 2); assert.equal(f.notices[1].tokens, null);
});

test('completion refreshes quota once, displays account delta and observes new tasks during refresh', async t => {
  let snapshot = { identityVerified: true, status: 'ready', ...quota(base), windows: quota(base).windows.map(w => ({ ...w, status: 'fresh' })) };
  let refreshCalls = 0, finishRefresh;
  const refreshed = new Promise(resolve => { finishRefresh = () => { snapshot = { ...snapshot, observedAt: base + 5000, windows: snapshot.windows.map(w => ({ ...w, usedPercent: 7 })) }; resolve(snapshot); }; });
  const f = await fixture(t, [usage(10, 1)], { getQuota: () => snapshot, refreshQuota: () => { refreshCalls++; return refreshed; } });
  await f.append([start('first'), usage(20, 2), complete('first'), complete('first')]);
  await pause(); assert.equal(refreshCalls, 1); assert.equal(f.notices.length, 0);
  await f.append([start('second')]); assert.equal(f.monitor.snapshot.activeTurns, 1);
  finishRefresh(); await pause();
  assert.equal(f.notices.length, 1); assert.match(f.notices[0].body, /账号已用上升 1 个百分点。$/);
});

test('a stalled quota refresh has a bounded wait and unchanged observations are explained', async t => {
  const snapshot = { identityVerified: true, status: 'ready', ...quota(base), windows: quota(base).windows.map(w => ({ ...w, status: 'fresh' })) };
  const f = await fixture(t, [usage(10, 1)], { getQuota: () => snapshot, refreshQuota: () => new Promise(() => {}), quotaTimeoutMs: 5 });
  await f.append([start(), usage(20, 2), complete()]); await pause();
  assert.equal(f.notices.length, 1); assert.match(f.notices[0].body, /尚无新的额度快照/);
});

test('absence of any turn counter is unknown, not a fabricated zero', async t => {
  const f = await fixture(t, [usage(10, 1)]);
  await f.append([start(), complete()]); await pause();
  assert.equal(f.notices[0].tokens, null);
});

test('duplicated session files share active identity and produce just one completion', async t => {
  const f = await fixture(t, [usage(10, 1)]);
  const copy = path.join(f.dir, 'rollout-copy.jsonl');
  await fs.copyFile(f.file, copy); await f.monitor.poll();
  await fs.appendFile(f.file, encoded([start()])); await fs.appendFile(copy, encoded([start()])); await f.monitor.poll();
  assert.equal(f.monitor.snapshot.activeTurns, 1);
  await fs.appendFile(f.file, encoded([usage(20, 2), complete()])); await fs.appendFile(copy, encoded([usage(20, 2), complete()])); await f.monitor.poll();
  await pause(); assert.equal(f.notices.length, 1);
});

test('stopping while a quota refresh is pending prevents a delayed notice', async t => {
  let finishRefresh;
  const f = await fixture(t, [usage(10, 1)], { refreshQuota: () => new Promise(resolve => { finishRefresh = resolve; }) });
  await f.append([start(), usage(20, 2), complete()]); await pause();
  f.monitor.stop(); finishRefresh(); await pause();
  assert.equal(f.notices.length, 0);
});
