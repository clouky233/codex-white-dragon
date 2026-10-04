import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { QuotaService, normalizeRateLimits } from '../src/quota.mjs';

const LIMIT = { usedPercent: 6, windowDurationMins: 10080, resetsAt: 10_000 };
const payload = (patch = {}) => ({ accountId: 'expected-test-account', rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { ...LIMIT }, secondary: null } }, ...patch });
const account = { account: { type: 'chatgpt', email: 'private@example.test', planType: 'test-plan' } };

function server(handler) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.killed = false;
  proc.send = message => { if (!proc.killed) proc.stdout.write(`${JSON.stringify(message)}\n`); };
  proc.reply = (request, result) => proc.send({ id: request.id, result });
  proc.kill = () => { if (!proc.killed) { proc.killed = true; queueMicrotask(() => proc.emit('exit', 0)); } };
  let buffer = '';
  proc.stdin.on('data', data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      queueMicrotask(() => handler(request, proc));
    }
  });
  return proc;
}

function service(t, overrides = {}, handler) {
  const requests = []; const children = [];
  const widget = new QuotaService({
    expectedAccountId: 'expected-test-account', now: () => 1_000_000,
    pollIntervalMs: 0, requestTimeoutMs: 100, reconnectMinMs: 20, reconnectMaxMs: 20,
    spawnImpl: () => {
      const child = server((request, proc) => {
        requests.push(request);
        if (handler?.(request, proc, children.length) === true) return;
        if (request.method === 'initialize') proc.reply(request, {});
        if (request.method === 'account/read') proc.reply(request, account);
        if (request.method === 'account/rateLimits/read') proc.reply(request, payload());
      });
      children.push(child); return child;
    }, ...overrides,
  });
  t.after(() => widget.stop());
  return { widget, requests, children };
}

async function until(predicate, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('one actual weekly primary window remains weekly, with no invented five-hour secondary', () => {
  const result = normalizeRateLimits(payload());
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].label, '每周');
  assert.equal(result.windows[0].remainingPercent, 94);
  assert.equal(result.windows[0].resetsAt, 10_000_000);
});

test('map buckets remain distinct and authoritative over legacy quota', () => {
  const result = normalizeRateLimits({ rateLimits: { limitId: 'wrong-legacy', primary: LIMIT }, rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { ...LIMIT, windowDurationMins: 300 } },
    other: { limitId: 'other', primary: { ...LIMIT, usedPercent: 50 } },
  } });
  assert.deepEqual(result.windows.map(w => w.id), ['codex:primary', 'other:primary']);
  assert.equal(result.windows[0].label, '五小时');
  assert.equal(normalizeRateLimits({ rateLimits: { primary: LIMIT }, rateLimitsByLimitId: {} }).windows.length, 0);
  assert.equal(normalizeRateLimits({ rateLimitsByLimitId: { codex: { limitId: 'other', primary: LIMIT } } }).windows.length, 0);
});

test('null, strings and out-of-range fields stay unknown instead of becoming zero or guessed resets', () => {
  for (const raw of [{}, { usedPercent: null }, { usedPercent: '10', windowDurationMins: '300', resetsAt: '10000' }, { usedPercent: 101, windowDurationMins: -2, resetsAt: -1 }, { usedPercent: NaN }]) {
    const result = normalizeRateLimits({ rateLimits: { primary: raw } });
    assert.equal(result.invalid, true);
    assert.equal(result.windows[0].usedPercent, null);
    assert.equal(result.windows[0].remainingPercent, null);
    assert.equal(result.windows[0].windowDurationMins, null);
    assert.equal(result.windows[0].resetsAt, null);
  }
  assert.equal(normalizeRateLimits({ rateLimits: { primary: { ...LIMIT, usedPercent: 0 } } }).windows[0].remainingPercent, 100);
});

test('handshake is ordered, refresh deduplicates, account is masked and requests remain read-only', async t => {
  const { widget, requests } = service(t);
  const start = widget.start();
  assert.equal(widget.refresh(), start);
  const snap = await start;
  assert.equal(snap.status, 'ready'); assert.equal(snap.identityVerified, true);
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(requests[2].params, { refreshToken: false });
  assert.equal(snap.account.masked, 'p***@example.test');
  assert.equal(JSON.stringify(snap).includes('expected-test-account'), false);
  assert.equal(JSON.stringify(snap).includes('private@example.test'), false);
  snap.windows[0].usedPercent = 99;
  assert.equal(widget.snapshot.windows[0].usedPercent, 6);
});

test('unbound installation labels account identity unverified; mismatch hides previously observed quota', async t => {
  const unbound = service(t, { expectedAccountId: null }).widget;
  assert.equal((await unbound.start()).status, 'unverified');
  assert.equal(unbound.snapshot.identityVerified, false);
  let mismatch = false;
  const { widget } = service(t, {}, (request, proc) => {
    if (request.method === 'account/rateLimits/read') { proc.reply(request, payload({ accountId: mismatch ? 'different-test-account' : 'expected-test-account' })); return true; }
  });
  await widget.start(); mismatch = true;
  const result = await widget.refresh();
  assert.equal(result.status, 'unavailable'); assert.equal(result.windows.length, 0);
  assert.equal(result.error.code, 'IDENTITY_MISMATCH'); assert.equal(result.observedAt, null);
});

test('missing account ID fails verification even when percentages look correct', async t => {
  const { widget } = service(t, {}, (request, proc) => {
    if (request.method === 'account/rateLimits/read') { proc.reply(request, payload({ accountId: null })); return true; }
  });
  const snap = await widget.start();
  assert.equal(snap.error.code, 'IDENTITY_MISSING'); assert.deepEqual(snap.windows, []);
});

test('age and reset boundaries expire the observation without restoring quota to 100 percent', async t => {
  let now = 1_000_000;
  const { widget } = service(t, { now: () => now, staleAfterMs: 60_000 });
  await widget.start(); now += 60_000;
  assert.equal(widget.snapshot.status, 'stale');
  now = 10_000_000;
  const snap = widget.snapshot;
  assert.equal(snap.status, 'expired'); assert.equal(snap.windows[0].status, 'expired');
  assert.equal(snap.windows[0].remainingPercent, 94); assert.equal(snap.observedAt, 1_000_000);
});

test('timeout preserves a labelled old observation and reconnects using a fresh handshake', async t => {
  let hang = false;
  const { widget, children, requests } = service(t, { requestTimeoutMs: 15 }, (request, proc, count) => request.method === 'account/rateLimits/read' && count === 1 && hang);
  await widget.start(); hang = true;
  const offline = await widget.refresh();
  assert.equal(offline.status, 'offline'); assert.equal(offline.error.code, 'TIMEOUT');
  assert.equal(offline.windows[0].remainingPercent, 94);
  await until(() => children.length === 2 && widget.snapshot.status === 'ready');
  assert.equal(requests.filter(r => r.method === 'initialize').length, 2);
  assert.equal(children[0].killed, true);
});

test('account change racing a quota response cannot attribute data to the previous account', async t => {
  const { widget } = service(t, {}, (request, proc) => {
    if (request.method === 'account/rateLimits/read') {
      proc.send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
      proc.reply(request, payload()); return true;
    }
  });
  const result = await widget.start();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED'); assert.equal(result.identityVerified, false);
  assert.equal(result.windows.length, 0);
});

test('initial account notification emitted by account/read does not reject the matching response', async t => {
  const { widget } = service(t, {}, (request, proc) => {
    if (request.method === 'account/read') {
      proc.send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'test-plan' } });
      proc.reply(request, account); return true;
    }
  });
  const result = await widget.start();
  assert.equal(result.status, 'ready'); assert.equal(result.identityVerified, true);
});

test('notifications emitted by our reads do not create an automatic refresh loop', async t => {
  const { widget, requests } = service(t, { notificationMinIntervalMs: 15 }, (request, proc) => {
    if (request.method === 'account/read') {
      proc.send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
      proc.reply(request, account); return true;
    }
    if (request.method === 'account/rateLimits/read') {
      // Exercise both notifications before and immediately after the RPC response.
      proc.send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: LIMIT } } });
      proc.reply(request, payload());
      proc.send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: LIMIT } } });
      return true;
    }
  });
  await widget.start();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(widget.snapshot.status, 'ready');
  assert.equal(requests.filter(r => r.method === 'account/rateLimits/read').length, 1);
  await widget.refresh();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(requests.filter(r => r.method === 'account/rateLimits/read').length, 2);
});

test('an idle push still refreshes, while a manual read consumes an already queued hint', async t => {
  const { widget, requests, children } = service(t, { notificationMinIntervalMs: 15 });
  await widget.start();
  children[0].send({ method: 'account/rateLimits/updated', params: {} });
  await until(() => requests.filter(r => r.method === 'account/rateLimits/read').length === 2);
  await widget.refresh(); // Dedup with the queued read if it is still finishing.
  const before = requests.filter(r => r.method === 'account/rateLimits/read').length;
  children[0].send({ method: 'account/rateLimits/updated', params: {} });
  await widget.refresh();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requests.filter(r => r.method === 'account/rateLimits/read').length, before + 1);
});

test('an account change during quota read rejects it and schedules exactly one identity recovery', async t => {
  let firstRead = true;
  const { widget, requests } = service(t, { notificationMinIntervalMs: 15 }, (request, proc) => {
    if (request.method === 'account/rateLimits/read' && firstRead) {
      firstRead = false;
      proc.send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
      proc.reply(request, payload()); return true;
    }
  });
  assert.equal((await widget.start()).error.code, 'ACCOUNT_CHANGED');
  await until(() => widget.snapshot.status === 'ready');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(widget.snapshot.identityVerified, true);
  assert.equal(requests.filter(r => r.method === 'account/rateLimits/read').length, 2);
});

test('stop during a pending request prevents retry and start can recover', async t => {
  const { widget, children } = service(t, {}, (request, proc, count) => count === 1 && request.method === 'account/read');
  const old = widget.start();
  await until(() => children.length === 1);
  widget.stop();
  const restarted = widget.start();
  await old; await restarted;
  assert.equal(widget.snapshot.status, 'ready'); assert.equal(children.length, 2);
  widget.stop();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children.length, 2); assert.equal(widget.snapshot.status, 'stopped');
});

test('arbitrary remote error messages are not forwarded to logs or the renderer', async t => {
  const { widget } = service(t, {}, (request, proc) => {
    if (request.method === 'account/rateLimits/read') {
      proc.send({ id: request.id, error: { code: -1, message: 'private-secret-should-not-appear' } }); return true;
    }
  });
  const result = await widget.start();
  assert.equal(result.error.code, 'READ_FAILED');
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
});
