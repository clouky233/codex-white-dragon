import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 1024 * 1024;
const MAX_TAIL = 768 * 1024;
const MAX_READ = 2 * 1024 * 1024;
const RECENT_MS = 12 * 60 * 60 * 1000;
const events = new Set(['task_started', 'turn_started', 'token_count', 'task_complete', 'turn_completed', 'task_aborted', 'turn_aborted', 'error', 'stream_error']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'number' && Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
const counters = value => value && count(value.input_tokens) && count(value.output_tokens) ? {
  input_tokens: value.input_tokens, output_tokens: value.output_tokens,
  cached_input_tokens: count(value.cached_input_tokens) ? value.cached_input_tokens : 0,
} : null;
const zero = () => ({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });

function quotaSample(snapshot) {
  if (!snapshot?.identityVerified || snapshot.status !== 'ready' || !Number.isFinite(snapshot.observedAt)) return null;
  return { observedAt: snapshot.observedAt, windows: (snapshot.windows || []).filter(w =>
    w.status === 'fresh' && typeof w.id === 'string' && Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 && w.usedPercent <= 100 && Number.isFinite(w.resetsAt)
  ).map(w => ({ id: w.id, label: String(w.label || '额度窗口').slice(0, 100), usedPercent: w.usedPercent, resetsAt: w.resetsAt })) };
}

/** Account observations only. This intentionally does not attribute percentages to a turn. */
export function compareQuota(before, after) {
  if (!before || !after) return { changes: [], note: '没有可比较的新鲜账号额度快照。' };
  if (after.observedAt <= before.observedAt) return { changes: [], note: '尚无新的额度快照，无法观察本轮期间的变化。' };
  const changes = [];
  let reset = false;
  for (const next of after.windows) {
    const previous = before.windows.find(w => w.id === next.id);
    if (!previous) continue;
    if (next.resetsAt !== previous.resetsAt || next.resetsAt <= after.observedAt || next.usedPercent < previous.usedPercent) { reset = true; continue; }
    changes.push({ id: next.id, label: next.label, usedPercentChange: Math.round((next.usedPercent - previous.usedPercent) * 100) / 100,
      observedFrom: before.observedAt, observedTo: after.observedAt, resetsAt: next.resetsAt });
  }
  return { changes, note: changes.length ? '' : reset ? '额度窗口已重置或数值回退，未计算本轮变化。' : '没有可比较的相同额度窗口。' };
}

/**
 * Read-only, bounded local session observer. Never returns conversation text, paths,
 * account IDs, errors from the transcript, or raw records. Unknown token baselines
 * stay unknown. Existing completions are not replayed when the widget starts.
 */
export class SessionMonitor extends EventEmitter {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), expectedAccountId = null,
    getQuota = () => null, refreshQuota = null, quotaTimeoutMs = 15000, pollIntervalMs = 1000, settleMs = 2000, now = Date.now } = {}) {
    super();
    Object.assign(this, { codexHome, expectedAccountId, getQuota, refreshQuota, quotaTimeoutMs, pollIntervalMs, settleMs, now });
    this.files = new Map();
    this.completed = new Map();
    this.running = false;
    this._status = expectedAccountId ? 'stopped' : 'unbound';
    this._activeCount = 0;
    this._pending = new Set();
  }

  get snapshot() {
    return { status: this._status, activeTurns: this._activeCount, observedFiles: [...this.files.values()].filter(f => f.accepted).length };
  }

  async start() {
    if (this.running) return this.snapshot;
    if (!this.expectedAccountId) { this._status = 'unbound'; return this.snapshot; }
    this.running = true;
    this._runVersion = (this._runVersion || 0) + 1;
    this.startedAt = this.now();
    this._status = 'watching';
    await this.poll(true);
    if (this.running && this.pollIntervalMs > 0) {
      this.timer = setInterval(() => { void this.poll(); }, Math.max(50, this.pollIntervalMs));
      this.timer.unref?.();
    }
    return this.snapshot;
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    for (const turn of this._pending) clearTimeout(turn.timer);
    this._pending.clear();
    this.files.clear();
    this._status = this.expectedAccountId ? 'stopped' : 'unbound';
    this._emitActive();
  }

  async poll(initial = false) {
    if (!this.running || this._polling) return this._polling;
    const task = this._scan(initial);
    this._polling = task;
    try { await task; } finally { if (this._polling === task) this._polling = null; }
    return this.snapshot;
  }

  async _listed() {
    // Only the last four calendar dates, at most 64 recent files. No full-history walk.
    const dirs = new Set();
    for (let day = 0; day < 4; day++) {
      const date = new Date(this.now() - day * 86400000);
      for (const utc of [false, true]) {
        const year = utc ? date.getUTCFullYear() : date.getFullYear();
        const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
        const dayOfMonth = utc ? date.getUTCDate() : date.getDate();
        dirs.add(path.join(this.codexHome, 'sessions', String(year), String(month).padStart(2, '0'), String(dayOfMonth).padStart(2, '0')));
      }
    }
    const found = [];
    for (const dir of dirs) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.slice(0, 512)) {
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        try { const stat = await fs.lstat(file); if (stat.isFile() && !stat.isSymbolicLink()) found.push({ file, stat }); } catch { /* file disappeared */ }
      }
    }
    return found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 64);
  }

  async _scan(initial) {
    let unreadable = false;
    this._recoveryBudget = 12 * 1024 * 1024;
    try {
      const listed = await this._listed();
      if (!this.running) return;
      const retained = new Set(listed.map(x => x.file));
      for (const [file, state] of this.files) if (!retained.has(file) && !state.active && !state.settling) this.files.delete(file);
      for (const { file, stat } of listed) {
        if (!this.running) return;
        try {
          let state = this.files.get(file);
          if (state && (stat.size < state.offset || stat.ino !== state.ino || stat.birthtimeMs !== state.birthtimeMs)) {
            if (state.settling) this._publish(state, state.settling);
            this.files.delete(file); state = null;
          }
          if (!state) state = await this._open(file, stat, initial);
          else if (state.accepted) await this._read(file, state, stat.size);
          if (state?.active && this.now() - state.active.startedAt > RECENT_MS) state.active = null;
        } catch { unreadable = true; }
      }
      this._status = unreadable ? 'partial' : this.files.size ? 'watching' : 'no-sessions';
      this._emitActive();
    } catch { this._status = 'unavailable'; }
  }

  async _open(file, stat, initial) {
    const handle = await fs.open(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(stat.size, 65536));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const newline = head.subarray(0, bytesRead).indexOf(10);
      if (newline < 0) return null; // The header may still be being written.
      let header;
      try { header = JSON.parse(head.subarray(0, newline).toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
      const meta = header.type === 'session_meta' ? header.payload : null;
      const accepted = !!meta && meta.creator_account_id === this.expectedAccountId &&
        typeof meta.id === 'string' && !meta.source?.subagent && meta.source !== 'subagent' && meta.thread_source !== 'subagent';
      const state = { accepted, ino: stat.ino, birthtimeMs: stat.birthtimeMs, offset: newline + 1, decoder: new StringDecoder('utf8'),
        pending: '', discard: false, id: accepted ? meta.id : null, total: null, active: null, settling: null,
        createdAt: accepted ? time(meta.timestamp) : NaN, forked: !!meta?.forked_from_id, priming: initial, sawLifecycle: false };
      if (!this.running) return null;
      this.files.set(file, state);
      if (!accepted) return state;
      const headerEnd = state.offset;
      if (stat.size - state.offset > MAX_TAIL) { state.offset = stat.size - MAX_TAIL; state.discard = true; }
      const tailStart = state.offset;
      await this._read(file, state, stat.size);
      if (!state.sawLifecycle && tailStart > headerEnd && stat.mtimeMs >= this.now() - RECENT_MS) {
        await this._recoverActive(handle, state, headerEnd, tailStart, stat.size);
      }
      state.priming = false;
      // An active turn recovered at startup lacks a start-time quota observation.
      if (initial && state.active) { state.active.beforeQuota = null; state.active.recovered = true; }
      return state;
    } finally { await handle.close(); }
  }

  async _recoverActive(handle, state, headerEnd, tailStart, size) {
    // A long task can begin before the normal tail. Search a bounded earlier slice
    // for its latest lifecycle event; never infer activity from token_count alone.
    const budget = Math.min(this._recoveryBudget, 8 * 1024 * 1024);
    if (budget <= 0) return;
    const from = Math.max(headerEnd, tailStart - budget);
    const end = Math.min(size, tailStart + 65536);
    const buffer = Buffer.alloc(end - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    this._recoveryBudget -= bytesRead;
    if (!this.running) return;
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (from > headerEnd) lines.shift();
    if (end < size) lines.pop();
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (line.length > MAX_LINE || !/"type"\s*:\s*"event_msg"/.test(line) ||
        !/"type"\s*:\s*"(?:task_started|turn_started|task_complete|turn_completed|task_aborted|turn_aborted|error)"/.test(line)) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'event_msg' || !events.has(event.payload?.type)) continue;
      const p = event.payload;
      if (p.type === 'error' && p.will_retry === true) continue;
      if (!['task_started', 'turn_started'].includes(p.type)) return;
      const at = Number.isFinite(time(p.started_at)) ? time(p.started_at) : time(event.timestamp);
      if (!Number.isFinite(at) || this.now() - at > RECENT_MS) return;
      const previous = state.priming;
      state.priming = true;
      this._accept(state, line);
      state.priming = previous;
      if (state.active) {
        state.active.known = false;
        state.active.recovered = true;
        state.active.beforeQuota = null;
      }
      return;
    }
  }

  async _read(file, state, size) {
    if (size <= state.offset) return;
    const handle = await fs.open(file, 'r');
    try {
      const length = Math.min(MAX_READ, size - state.offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      if (!this.running) return;
      state.offset += bytesRead;
      const content = state.pending + state.decoder.write(buffer.subarray(0, bytesRead));
      state.pending = '';
      let from = 0, end;
      while ((end = content.indexOf('\n', from)) >= 0) {
        if (state.discard) state.discard = false;
        else if (end - from <= MAX_LINE) this._accept(state, content.slice(from, end));
        from = end + 1;
      }
      state.pending = content.slice(from);
      if (state.pending.length > MAX_LINE) { state.pending = ''; state.discard = true; }
    } finally { await handle.close(); }
  }

  _accept(state, line) {
    // Non-lifecycle records, including user/assistant text and tool payloads, are discarded.
    if (!/"type"\s*:\s*"event_msg"/.test(line) || !/"type"\s*:\s*"(?:task_started|turn_started|token_count|task_complete|turn_completed|task_aborted|turn_aborted|error|stream_error)"/.test(line)) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const p = event.type === 'event_msg' ? event.payload : null;
    if (!p || !events.has(p.type)) return;
    const at = time(event.timestamp);
    if (!Number.isFinite(at) || at > this.now() + 60000 || state.forked && Number.isFinite(state.createdAt) && at < state.createdAt) return;
    const turnId = typeof (p.turn_id ?? p.turnId) === 'string' ? (p.turn_id ?? p.turnId) : null;
    if (['task_started', 'turn_started', 'task_complete', 'turn_completed', 'task_aborted', 'turn_aborted'].includes(p.type)) state.sawLifecycle = true;
    if (p.type === 'error' && p.will_retry !== true || p.type === 'stream_error' && (p.will_retry === false || p.fatal === true)) state.sawLifecycle = true;
    if (p.type === 'task_started' || p.type === 'turn_started') {
      if (!turnId || state.active?.turnId === turnId || this.completed.has(`${state.id}:${turnId}`)) return;
      const startedAt = Number.isFinite(time(p.started_at)) ? time(p.started_at) : at;
      if (state.forked && Number.isFinite(state.createdAt) && startedAt < state.createdAt - 1000) return;
      if (state.settling) this._publish(state, state.settling);
      state.active = { id: `${state.id}:${turnId}`, turnId, startedAt, tokens: zero(), known: !!state.total,
        observedCounter: false, beforeQuota: state.priming ? null : this._quota(), overlapped: false, recovered: state.priming };
      for (const other of this.files.values()) if (other !== state && other.active && other.active.id !== state.active.id) { other.active.overlapped = true; state.active.overlapped = true; }
      this._emitActive();
      return;
    }
    if (p.type === 'token_count') {
      const next = counters(p.info?.total_token_usage);
      const turn = state.active || state.settling;
      if (turnId && turn?.turnId !== turnId) {
        // A late counter explicitly belonging to the previous turn cannot be charged
        // to a newer turn. Keep its cumulative baseline, but mark overlap uncertain.
        if (turn) turn.known = false;
        if (next) state.total = next;
        return;
      }
      if (!next) { if (turn) turn.known = false; return; }
      if (turn) {
        turn.observedCounter = true;
        if (!state.total || Object.keys(next).some(key => next[key] < state.total[key])) turn.known = false;
        else for (const key of Object.keys(next)) turn.tokens[key] += next[key] - state.total[key];
      }
      state.total = next;
      return;
    }
    if (['error', 'stream_error'].includes(p.type)) {
      if (!state.active || turnId && turnId !== state.active.turnId || p.will_retry === true) return;
      if (p.type === 'stream_error' && p.will_retry !== false && p.fatal !== true) return;
      this._finish(state, p, at, 'error');
      return;
    }
    if (!turnId) return;
    if (state.settling?.turnId === turnId && /aborted$/.test(p.type)) {
      clearTimeout(state.settling.timer); this._pending.delete(state.settling); state.settling = null;
      return;
    }
    if (!state.active || state.active.turnId !== turnId) return;
    const cancelled = /aborted$/.test(p.type) || ['cancelled', 'canceled', 'aborted', 'interrupted', 'incomplete'].includes(p.status);
    const kind = cancelled ? 'cancel' : p.error || ['failed', 'error'].includes(p.status) ? 'error' : 'complete';
    this._finish(state, p, at, kind);
  }

  _finish(state, payload, at, kind) {
    const turn = state.active;
    state.active = null;
    if (this.completed.has(turn.id)) { this._emitActive(); return; }
    this.completed.set(turn.id, this.now());
    if (this.completed.size > 2048) this.completed.delete(this.completed.keys().next().value);
    this._emitActive();
    turn.completedAt = Number.isFinite(time(payload.completed_at)) ? time(payload.completed_at) : at;
    turn.durationMs = count(payload.duration_ms) ? payload.duration_ms : Math.max(0, turn.completedAt - turn.startedAt);
    turn.kind = kind;
    turn.runVersion = this._runVersion;
    if (kind === 'cancel' || state.priming || turn.completedAt < this.startedAt) return;
    state.settling = turn;
    this._pending.add(turn);
    turn.timer = setTimeout(() => this._publish(state, turn), Math.max(0, this.settleMs));
    turn.timer.unref?.();
  }

  _quota() { try { return quotaSample(this.getQuota()); } catch { return null; } }

  async _publish(state, turn) {
    if (state.settling !== turn) return;
    clearTimeout(turn.timer);
    state.settling = null;
    if (!this.running) return;
    // Release the per-file settling slot before I/O, so following tasks continue to
    // be observed while the read-only quota refresh is in flight.
    const tokens = turn.known && turn.observedCounter ? { ...turn.tokens, total_tokens: turn.tokens.input_tokens + turn.tokens.output_tokens } : null;
    if (typeof this.refreshQuota === 'function') {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(() => this.refreshQuota()), new Promise(resolve => {
          timer = setTimeout(resolve, Math.max(1, this.quotaTimeoutMs)); timer.unref?.();
        })]);
      } catch { /* A failed refresh remains unavailable or unchanged; no invented delta. */ }
      finally { clearTimeout(timer); }
    }
    this._pending.delete(turn);
    if (!this.running || turn.runVersion !== this._runVersion) return;
    const compared = compareQuota(turn.beforeQuota, this._quota());
    const changes = compared.changes.map(change => `${change.label}：账号已用${change.usedPercentChange === 0 ? '未观察到变化（0 个百分点）' : `上升 ${change.usedPercentChange} 个百分点`}。`).join(' ');
    const duration = Math.round(turn.durationMs / 1000);
    const body = [`耗时 ${duration} 秒。`, tokens ? `本机主任务记录 ${tokens.total_tokens.toLocaleString('zh-CN')} token（输入 ${tokens.input_tokens.toLocaleString('zh-CN')}，输出 ${tokens.output_tokens.toLocaleString('zh-CN')}；不含子代理）。` : '本轮 token 基线不完整，无法核验总用量。',
      changes, compared.note, turn.overlapped ? '检测到并行主任务，无法把账号变化归因于单个任务。' : '', turn.recovered ? '任务开始早于挂件启动。' : ''].filter(Boolean).join(' ');
    this.emit('notice', { id: turn.id, kind: turn.kind, title: turn.kind === 'complete' ? '任务已完成' : '任务出错', body,
      completedAt: turn.completedAt, durationMs: turn.durationMs, tokens, quotaChanges: compared.changes });
  }

  _emitActive() {
    const count = new Set([...this.files.values()].filter(state => state.active).map(state => state.active.id)).size;
    if (count !== this._activeCount) { this._activeCount = count; this.emit('active', count); }
  }
}
