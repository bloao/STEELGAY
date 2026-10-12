// Shared helpers for the order tool pages.
(function () {
  "use strict";

  // Pages opened from disk or from PyCharm's preview server (:63342) still
  // talk to the Node server on :3000.
  const API_BASE = window.location.protocol === "file:" || window.location.port === "63342"
    ? "http://localhost:3000"
    : "";

  function showServerProblem(error) {
    if (document.getElementById("server-problem")) return;
    const unreachable = !error || error.status === undefined || error.status === 0;
    const oldServer = error && error.status === 404;
    if (!unreachable && !oldServer) return;
    const box = el("div", { id: "server-problem", class: "notice notice-bad", role: "alert", style: "margin:0" },
      el("strong", { text: oldServer ? "The server running is an old version. " : "Can't reach the order tool server. " }),
      oldServer
        ? "Stop it (Ctrl+C in its terminal) and start it again with "
        : "In the project folder run ",
      el("code", { text: "node server.mjs" }),
      ", then open ",
      el("a", { href: "http://127.0.0.1:3000/orders.html", text: "http://127.0.0.1:3000/orders.html" }),
      ".");
    const page = document.querySelector("main.page");
    if (page) page.prepend(box);
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: options.body ? { "content-type": "application/json" } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: API_BASE ? "include" : "same-origin",
      });
    } catch (networkError) {
      const error = new Error("Server not reachable");
      error.status = 0;
      showServerProblem(error);
      throw error;
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      const error = new Error((data && (data.error || (data.errors && Object.values(data.errors)[0]))) || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      if (response.status === 404 && path.startsWith("/api/")) showServerProblem(error);
      throw error;
    }
    return data;
  }

  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
  const gbp2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fmt = {
    money(v, exact) { return Number.isFinite(v) ? (exact ? gbp2 : gbp).format(v) : "—"; },
    perT(v) { return Number.isFinite(v) ? `${gbp2.format(v)}/t` : "—"; },
    tonnes(v) { return Number.isFinite(v) ? `${v.toLocaleString("en-GB", { maximumFractionDigits: 3 })} t` : "—"; },
    tonnesRound(v) { return Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")} t` : "—"; },
    pct(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—"; },
    date(v) {
      if (!v) return "—";
      return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(v.length === 10 ? `${v}T00:00:00` : v));
    },
    dateTime(v) {
      if (!v) return "—";
      return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(v));
    },
    time(v) {
      if (!v) return "—";
      return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(v));
    },
  };

  const STATUS = {
    draft: ["Draft", ""],
    submitted: ["Awaiting approval", "badge-info"],
    approved: ["Approved", "badge-good"],
    rejected: ["Rejected", "badge-bad"],
    archived: ["Archived", ""],
  };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function statusBadge(status, quoteValidUntil) {
    const today = new Date().toISOString().slice(0, 10);
    if (status === "draft" && quoteValidUntil && quoteValidUntil < today) return el("span", { class: "badge", text: "Quote expired" });
    const [label, cls] = STATUS[status] || [status, ""];
    return el("span", { class: `badge ${cls}`, text: label });
  }

  function quotaBadge(row) {
    if (row.quotaProbability === null || row.quotaProbability === undefined) return el("span", { class: "badge", text: "N/A" });
    if (row.quotaMatched === false) return el("span", { class: "badge badge-bad", text: "No quota line" });
    if (row.quotaProbability >= 0.5) return el("span", { class: "badge badge-bad", text: `Exhaust risk ${fmt.pct(row.quotaProbability)}` });
    if (row.quotaProbability > 0) return el("span", { class: "badge badge-warn", text: `Some risk ${fmt.pct(row.quotaProbability)}` });
    return el("span", { class: "badge badge-good", text: "Headroom" });
  }

  let toastTimer;
  function toast(message, isError) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status", "aria-live": "polite" });
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.toggle("is-error", Boolean(isError));
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 2800);
  }

  async function loadDataStatus(target) {
    if (!target) return;
    try {
      const status = await api("/api/data-status");
      if (status.quotasFetchedAt) {
        const age = (Date.now() - Date.parse(status.quotasFetchedAt)) / 60000;
        target.textContent = `Quota data from ${fmt.time(status.quotasFetchedAt)}`;
        target.classList.toggle("is-stale", age > 60);
      } else {
        target.textContent = "Quota data loads on first calculation";
      }
    } catch {
      target.textContent = "Data status unavailable";
      target.classList.add("is-stale");
    }
  }

  async function loadMe() {
    try { return await api("/api/me"); } catch { return { name: "unknown", role: "viewer", canEdit: false, canApprove: false }; }
  }

  window.OrderTool = { api, apiBase: API_BASE, fmt, el, statusBadge, quotaBadge, toast, loadDataStatus, loadMe, STATUS, showServerProblem };
})();
