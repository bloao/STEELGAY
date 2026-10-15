// Keeps every data source on a constant feed: each one runs on its own
// interval, failures retry with a growing back-off (never longer than the
// interval), and a status record says whether it's live, stale or failing.
// Pure scheduling logic; the server injects what each feed does.

const MIN = 60_000;
export const RETRY_STEPS = [1, 2, 5, 15, 30, 60].map((m) => m * MIN);

export function nextDelay(feed, ok, failures) {
  if (ok) return feed.intervalMs;
  return Math.min(RETRY_STEPS[Math.min(failures - 1, RETRY_STEPS.length - 1)], feed.intervalMs);
}

// live: fresh within 1.5 intervals · stale: older · error: last run failed · off: needs setting up
export function statusOf(rec, feed, now = Date.now()) {
  if (rec.state === "off") return "off";
  if (rec.running && !rec.lastOkAt) return "connecting";
  if (feed.stream) return rec.connected ? "live" : rec.lastError ? "error" : "connecting";
  if (rec.lastError && (!rec.lastOkAt || Date.parse(rec.lastErrorAt) >= Date.parse(rec.lastOkAt))) return rec.lastOkAt && now - Date.parse(rec.lastOkAt) < feed.intervalMs * 1.5 ? "retrying" : "error";
  if (!rec.lastOkAt) return "waiting";
  return now - Date.parse(rec.lastOkAt) < feed.intervalMs * 1.5 ? "live" : "stale";
}

export function createFeedManager({ feeds, onChange = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  const recs = new Map(feeds.map((f) => [f.key, { key: f.key, failures: 0, runs: 0, lastOkAt: null, lastErrorAt: null, lastError: null, nextAt: null, running: false, detail: null, state: "on", connected: false }]));
  const timers = new Map();
  const byKey = new Map(feeds.map((f) => [f.key, f]));

  function schedule(key, delay) {
    clearTimer(timers.get(key));
    const rec = recs.get(key);
    rec.nextAt = new Date(now() + delay).toISOString();
    const t = setTimer(() => run(key).catch(() => {}), delay);
    if (t && t.unref) t.unref();
    timers.set(key, t);
  }

  async function run(key, { manual = false } = {}) {
    const feed = byKey.get(key), rec = recs.get(key);
    if (!feed || rec.running) return view(key);
    rec.running = true;
    onChange(view(key));
    let ok = false;
    try {
      const res = await feed.run({ manual });
      if (res && res.off) { rec.state = "off"; rec.detail = res.detail || null; rec.lastError = null; ok = true; }
      else {
        rec.state = "on";
        ok = !(res && res.ok === false);
        if (ok) { rec.lastOkAt = new Date(now()).toISOString(); rec.failures = 0; rec.lastError = null; rec.detail = res && res.detail ? res.detail : rec.detail; }
        else throw new Error(res.error || "Failed");
      }
      if (res && "connected" in res) rec.connected = Boolean(res.connected);
    } catch (error) {
      rec.failures += 1;
      rec.lastError = String(error.message || error).slice(0, 300);
      rec.lastErrorAt = new Date(now()).toISOString();
      log(`${feed.name}: ${rec.lastError} (retry ${rec.failures})`);
    } finally {
      rec.running = false;
      rec.runs += 1;
    }
    schedule(key, rec.state === "off" ? feed.intervalMs : nextDelay(feed, ok, rec.failures));
    const v = view(key);
    onChange(v);
    return v;
  }

  function view(key) {
    const f = byKey.get(key), r = recs.get(key);
    return { key, name: f.name, source: f.source, url: f.url || null, what: f.what || "", every: f.intervalMs, stream: Boolean(f.stream), needs: f.needs || null,
      status: statusOf(r, f, now()), lastOkAt: r.lastOkAt, lastError: r.lastError, lastErrorAt: r.lastErrorAt, failures: r.failures, nextAt: r.nextAt, running: r.running, detail: r.detail, runs: r.runs };
  }

  return {
    start() { feeds.forEach((f, i) => schedule(f.key, f.firstDelayMs ?? 5_000 + i * 2_000)); },
    stop() { for (const t of timers.values()) clearTimer(t); timers.clear(); },
    run,
    list: () => feeds.map((f) => view(f.key)),
    get: (key) => (byKey.has(key) ? view(key) : null),
    // streams (e.g. ship tracking) report their own connection state
    report(key, patch) { const r = recs.get(key); if (!r) return; Object.assign(r, patch); if (patch.connected) { r.lastOkAt = new Date(now()).toISOString(); r.lastError = null; r.failures = 0; } onChange(view(key)); },
  };
}
