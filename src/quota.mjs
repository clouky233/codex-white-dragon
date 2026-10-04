import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const SOURCE = 'codex-app-server';
const ERROR_TEXT = {
  NOT_STARTED: '额度服务尚未启动。', STOPPED: '额度服务已停止。',
  SPAWN_FAILED: '无法启动 Codex，请检查可执行文件路径。', DISCONNECTED: 'Codex 额度连接已断开，正在重试。',
  TIMEOUT: '额度读取超时，正在重试。', PROTOCOL_ERROR: 'Codex 返回了无法识别的数据。',
  READ_FAILED: 'Codex 未能读取额度，请检查登录及网络连接。',
  NOT_SIGNED_IN: '当前 Codex sidecar 尚未登录 ChatGPT 订阅账号。',
  IDENTITY_UNVERIFIED: '已读取 sidecar 账号额度，但尚未与桌面账号核对。',
  IDENTITY_MISSING: '返回中没有账户标识，无法核对桌面账号。',
  IDENTITY_MISMATCH: 'Sidecar 与绑定的桌面账号或工作区不一致，已隐藏额度。',
  ACCOUNT_CHANGED: '账号状态发生变化，正在重新核对。',
  NO_WINDOWS: '服务未返回订阅额度窗口。', INVALID_DATA: '部分额度字段缺失或异常，未知值未作估算。',
};
const safeError = code => ({ code, message: ERROR_TEXT[code] ?? ERROR_TEXT.READ_FAILED });
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length ? value.slice(0, 200) : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const maskEmail = value => {
  if (typeof value !== 'string' || !value) return null;
  const split = value.lastIndexOf('@');
  return split > 0 ? `${value[0]}***@${value.slice(split + 1, split + 81)}` : `${value[0]}***`;
};

/** Converts only quota fields. Does not retain account IDs, credits, tokens or server errors. */
export function normalizeRateLimits(payload) {
  const windows = [];
  let invalid = false;
  if (!object(payload)) return { windows, invalid: true };
  // A provided map is authoritative, including an empty map. Never substitute a legacy bucket.
  let entries;
  if (payload.rateLimitsByLimitId != null) {
    if (!object(payload.rateLimitsByLimitId)) return { windows, invalid: true };
    entries = Object.entries(payload.rateLimitsByLimitId);
  } else if (object(payload.rateLimits)) {
    entries = [[text(payload.rateLimits.limitId) ?? 'legacy', payload.rateLimits]];
  } else return { windows, invalid: false };

  for (const [key, bucket] of entries.slice(0, 100)) {
    if (!object(bucket) || (text(bucket.limitId) && bucket.limitId !== key)) { invalid = true; continue; }
    for (const slot of ['primary', 'secondary']) {
      const raw = bucket[slot];
      if (raw == null) continue;
      if (!object(raw)) { invalid = true; continue; }
      const usedPercent = finite(raw.usedPercent) && raw.usedPercent >= 0 && raw.usedPercent <= 100 ? raw.usedPercent : null;
      const duration = finite(raw.windowDurationMins) && raw.windowDurationMins > 0 && Number.isInteger(raw.windowDurationMins) ? raw.windowDurationMins : null;
      const resetsAt = finite(raw.resetsAt) && Number.isInteger(raw.resetsAt) && raw.resetsAt > 0 && raw.resetsAt <= 8.64e12 ? raw.resetsAt * 1000 : null;
      if (usedPercent === null || duration === null || resetsAt === null) invalid = true;
      const label = duration === 300 ? '五小时' : duration === 10080 ? '每周' : duration === null ? '未知窗口' : `${duration} 分钟`;
      windows.push({
        id: `${key}:${slot}`, limitId: key, limitName: text(bucket.limitName), slot,
        label: key === 'codex' || key === 'legacy' ? label : `${text(bucket.limitName) ?? key} · ${label}`,
        usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
        windowDurationMins: duration, resetsAt,
      });
    }
  }
  if (entries.length > 100) invalid = true;
  return { windows, invalid };
}

/**
 * Read-only app-server sidecar. Only initialize, account/read and account/rateLimits/read
 * requests are issued. Never logs raw responses, accesses credential files, starts turns,
 * signs in/out, consumes rate-limit resets or sends email.
 *
 * Events: 'snapshot' with the same safe shape as the snapshot getter.
 * start()/refresh() resolve to a snapshot on both success and network failure; stop() is sync.
 * expectedAccountId is a local binding supplied by the host, never a packaged constant.
 * Without it, data is explicit 'unverified'; a mismatch hides all windows.
 */
export class QuotaService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      codexPath: options.codexPath || (process.platform === 'win32' ? 'codex.exe' : 'codex'),
      expectedAccountId: options.expectedAccountId || null,
      pollIntervalMs: options.pollIntervalMs ?? 60_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      staleAfterMs: options.staleAfterMs ?? 15 * 60_000,
      reconnectMinMs: options.reconnectMinMs ?? 3_000,
      reconnectMaxMs: options.reconnectMaxMs ?? 60_000,
      notificationMinIntervalMs: options.notificationMinIntervalMs ?? 5_000,
      spawnImpl: options.spawnImpl ?? spawn,
      now: options.now ?? Date.now,
    };
    this._running = false;
    this._proc = null;
    this._ready = false;
    this._nextId = 0;
    this._pending = new Map();
    this._refreshPromise = null;
    this._connectPromise = null;
    this._retryCount = 0;
    this._authVersion = 0;
    this._runVersion = 0;
    this._lastEventKey = null;
    this._lastRefreshAttempt = 0;
    this._data = { windows: [], source: SOURCE, observedAt: null, status: 'unavailable', error: safeError('NOT_STARTED'), account: null, identityVerified: false };
  }

  get snapshot() {
    const snap = structuredClone(this._data);
    const now = this.options.now();
    const stale = snap.observedAt != null && now - snap.observedAt >= this.options.staleAfterMs;
    snap.windows = snap.windows.map(window => ({ ...window,
      status: window.resetsAt !== null && window.resetsAt <= now ? 'expired' : stale ? 'stale' : window.usedPercent === null ? 'unknown' : 'fresh',
    }));
    if (snap.status !== 'stopped' && snap.windows.length) {
      if (snap.windows.some(window => window.status === 'expired')) snap.status = 'expired';
      else if (stale) snap.status = 'stale';
    }
    return snap;
  }

  start() {
    if (!this._running) {
      this._running = true;
      this._runVersion += 1;
      if (this.options.pollIntervalMs > 0) {
        this._pollTimer = setInterval(() => { void this.refresh(); }, this.options.pollIntervalMs);
        this._pollTimer.unref?.();
      }
      // Re-evaluate age/reset even if the network is down; it does not manufacture refreshed data.
      this._ageTimer = setInterval(() => this._publish(), 1_000);
      this._ageTimer.unref?.();
    }
    return this.refresh();
  }

  refresh() {
    if (!this._running) return Promise.resolve(this.snapshot);
    if (this._refreshPromise) return this._refreshPromise;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    // A manual/poll read also covers any previously queued push hint.
    clearTimeout(this._notificationTimer);
    this._notificationTimer = null;
    const task = this._refreshOnce();
    this._refreshPromise = task;
    void task.finally(() => { if (this._refreshPromise === task) this._refreshPromise = null; });
    return task;
  }

  stop() {
    this._running = false;
    this._runVersion += 1;
    clearInterval(this._pollTimer);
    clearInterval(this._ageTimer);
    clearTimeout(this._retryTimer);
    clearTimeout(this._notificationTimer);
    this._notificationTimer = null;
    this._destroyConnection('STOPPED');
    this._refreshPromise = null;
    this._connectPromise = null;
    this._data.status = 'stopped';
    this._data.error = safeError('STOPPED');
    this._data.identityVerified = false;
    this._publish(true);
  }

  async _refreshOnce() {
    const runVersion = this._runVersion;
    this._lastRefreshAttempt = this.options.now();
    try {
      if (!this._data.windows.length) { this._data.status = 'connecting'; this._data.error = null; this._publish(); }
      await this._connect();
      if (!this._running || runVersion !== this._runVersion) return this.snapshot;
      const response = await this._request('account/read', { refreshToken: false });
      if (!this._running || runVersion !== this._runVersion) return this.snapshot;
      // account/read itself can emit the initial account/updated notification. Its completed
      // response is the baseline; only subsequent changes invalidate this quota observation.
      const authVersion = this._authVersion;
      const account = response?.account;
      if (!object(account) || !['chatgpt', 'chatgptAuthTokens'].includes(account.type)) {
        this._clear('NOT_SIGNED_IN');
        return this.snapshot;
      }
      const accountDisplay = { masked: maskEmail(account.email), plan: text(account.planType), type: text(account.type) };
      const quota = await this._request('account/rateLimits/read', {});
      if (!this._running || runVersion !== this._runVersion) return this.snapshot;
      if (authVersion !== this._authVersion) {
        this._clear('ACCOUNT_CHANGED');
        // This observation was rejected, so a fresh identity check is still necessary.
        // Ordinary pushes during a successful read never schedule this follow-up.
        this._scheduleNotificationRefresh();
        return this.snapshot;
      }
      const observedAccountId = text(quota?.accountId);
      const expected = this.options.expectedAccountId;
      if (expected && !observedAccountId) { this._clear('IDENTITY_MISSING', accountDisplay); return this.snapshot; }
      if (expected && observedAccountId !== expected) { this._clear('IDENTITY_MISMATCH', accountDisplay); return this.snapshot; }
      const verified = Boolean(expected && expected === observedAccountId);
      const { windows, invalid } = normalizeRateLimits(quota);
      this._data = {
        windows, source: SOURCE, observedAt: this.options.now(),
        status: !windows.length ? 'unavailable' : verified ? 'ready' : 'unverified',
        error: !windows.length ? safeError(invalid ? 'INVALID_DATA' : 'NO_WINDOWS') : !verified ? safeError('IDENTITY_UNVERIFIED') : invalid ? safeError('INVALID_DATA') : null,
        account: accountDisplay, identityVerified: verified,
      };
      this._retryCount = 0;
      this._publish(true);
    } catch (error) {
      if (!this._running || runVersion !== this._runVersion) return this.snapshot;
      const code = Object.hasOwn(ERROR_TEXT, error?.code) ? error.code : 'READ_FAILED';
      this._destroyConnection(code);
      this._data.status = this._data.windows.length ? 'offline' : 'unavailable';
      this._data.error = safeError(code);
      // identityVerified describes the identity of the retained observation, not live connectivity.
      this._publish(true);
      this._scheduleRetry();
    }
    return this.snapshot;
  }

  _clear(code, account = null) {
    this._data = { windows: [], source: SOURCE, observedAt: null, status: 'unavailable', error: safeError(code), account, identityVerified: false };
    this._publish(true);
  }

  _publish(force = false) {
    const snap = this.snapshot;
    const key = JSON.stringify(snap);
    if (force || key !== this._lastEventKey) { this._lastEventKey = key; this.emit('snapshot', snap); }
  }

  async _connect() {
    if (this._proc && this._ready) return;
    if (this._connectPromise) return this._connectPromise;
    const task = (async () => {
      if (!this._running) throw fail('STOPPED');
      let proc;
      try { proc = this.options.spawnImpl(this.options.codexPath, ['app-server', '--stdio'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { throw fail('SPAWN_FAILED'); }
      this._proc = proc;
      this._ready = false;
      let buffer = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => {
        if (this._proc !== proc) return;
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) { this._connectionLost(proc, 'PROTOCOL_ERROR'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { this._connectionLost(proc, 'PROTOCOL_ERROR'); return; }
          this._onMessage(message);
        }
      });
      proc.stderr?.resume(); // Never forward raw diagnostics to a renderer or log file.
      proc.stdin.on('error', () => this._connectionLost(proc, 'DISCONNECTED'));
      proc.on('error', () => this._connectionLost(proc, 'SPAWN_FAILED'));
      proc.on('exit', () => this._connectionLost(proc, 'DISCONNECTED'));
      await this._request('initialize', { clientInfo: { name: 'white_dragon_quota_widget', title: 'White Dragon Quota Widget', version: '0.1.0' } });
      if (this._proc !== proc || !this._running) throw fail('DISCONNECTED');
      this._send({ method: 'initialized', params: {} });
      this._ready = true;
    })();
    this._connectPromise = task;
    try { await task; } finally { if (this._connectPromise === task) this._connectPromise = null; }
  }

  _request(method, params) {
    if (!this._proc || !this._running) return Promise.reject(fail('DISCONNECTED'));
    return new Promise((resolve, reject) => {
      const id = ++this._nextId;
      const timer = setTimeout(() => { this._pending.delete(id); reject(fail('TIMEOUT')); }, this.options.requestTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this._send({ id, method, params }); }
      catch { clearTimeout(timer); this._pending.delete(id); reject(fail('DISCONNECTED')); }
    });
  }

  _send(message) { this._proc.stdin.write(`${JSON.stringify(message)}\n`); }

  _onMessage(message) {
    if (!object(message)) { this._connectionLost(this._proc, 'PROTOCOL_ERROR'); return; }
    if (Object.hasOwn(message, 'id') && this._pending.has(message.id)) {
      const pending = this._pending.get(message.id);
      this._pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(fail('READ_FAILED')); else pending.resolve(message.result);
      return;
    }
    // Decline server-initiated requests, including requests for externally managed auth tokens.
    if (Object.hasOwn(message, 'id') && message.method) {
      try { this._send({ id: message.id, error: { code: -32601, message: 'Unsupported by read-only quota client' } }); } catch { /* disconnect handler owns recovery */ }
      return;
    }
    if (message.method === 'account/updated') {
      this._authVersion += 1;
      this._clear('ACCOUNT_CHANGED');
      // account/read can emit this itself. The in-flight account response establishes
      // its baseline; a later change is detected by _refreshOnce and retried there.
      if (!this._refreshPromise) this._scheduleNotificationRefresh();
    } else if (message.method === 'account/rateLimits/updated') {
      // app-server can echo a notification while handling our own rateLimits/read.
      // That read already supplies fresh, identity-checked data. Queuing another read
      // here would create a self-sustaining five-second request loop.
      if (!this._refreshPromise) this._scheduleNotificationRefresh();
    }
  }

  _scheduleNotificationRefresh() {
    if (!this._running || this._notificationTimer) return;
    const wait = Math.max(10, this.options.notificationMinIntervalMs - (this.options.now() - this._lastRefreshAttempt));
    this._notificationTimer = setTimeout(() => {
      this._notificationTimer = null;
      if (this._refreshPromise) { this._scheduleNotificationRefresh(); return; }
      void this.refresh();
    }, wait);
    this._notificationTimer.unref?.();
  }

  _connectionLost(proc, code) {
    if (!proc || this._proc !== proc) return;
    this._destroyConnection(code);
    if (!this._running) return;
    this._data.status = this._data.windows.length ? 'offline' : 'unavailable';
    this._data.error = safeError(code);
    this._publish(true);
    this._scheduleRetry();
  }

  _destroyConnection(code) {
    const proc = this._proc;
    this._proc = null;
    this._ready = false;
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(fail(code)); }
    this._pending.clear();
    if (proc) {
      try { proc.stdin.end(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already exited */ }
    }
  }

  _scheduleRetry() {
    if (!this._running || this._retryTimer) return;
    const delay = Math.min(this.options.reconnectMaxMs, this.options.reconnectMinMs * 2 ** Math.min(this._retryCount++, 8));
    this._retryTimer = setTimeout(() => { this._retryTimer = null; void this.refresh(); }, delay);
    this._retryTimer.unref?.();
  }
}
