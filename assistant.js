(function () {
  "use strict";
  const { api, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const input = $("question");
  const STORE_KEY = "agx-assistant-chat";
  let history = [];
  let busy = false;

  try { history = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); } catch { history = []; }
  const persist = () => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-40))); } catch { /* storage unavailable */ } };

  // ---- small, safe markdown → DOM (no innerHTML) --------------------------
  function inline(text) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith("**")) out.push(el("strong", { text: t.slice(2, -2) }));
      else if (t.startsWith("`")) out.push(el("code", { text: t.slice(1, -1) }));
      else {
        const [, label, href] = t.match(/^\[([^\]]+)\]\((.+)\)$/);
        out.push(el("a", { href, target: "_blank", rel: "noopener", text: label }));
      }
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function markdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src).replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
        const [headRow, ...rest] = body;
        frag.append(el("table", {},
          el("thead", {}, el("tr", {}, ...cells(headRow).map((c) => el("th", {}, ...inline(c))))),
          el("tbody", {}, ...rest.map((r) => el("tr", {}, ...cells(r).map((c) => el("td", {}, ...inline(c))))))));
        continue;
      }
      const heading = line.match(/^#{1,4}\s+(.*)/);
      if (heading) { frag.append(el("h3", {}, ...inline(heading[1]))); i += 1; continue; }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]/.test(line);
        const list = el(ordered ? "ol" : "ul");
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          list.append(el("li", {}, ...inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))));
          i += 1;
        }
        frag.append(list);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(\||#{1,4}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i])) { para.push(lines[i]); i += 1; }
      const p = el("p");
      para.forEach((l, n) => { if (n) p.append(el("br")); p.append(...inline(l)); });
      frag.append(p);
    }
    return frag;
  }

  // ---- rendering ----------------------------------------------------------
  function addMessage(msg) {
    $("empty").hidden = true;
    const node = msg.role === "user"
      ? el("div", { class: "msg msg-user" }, el("div", { class: "bubble", text: msg.content }))
      : el("div", { class: `msg msg-bot${msg.error ? " msg-error" : ""}` },
          msg.tools && msg.tools.length
            ? el("div", { class: "tool-chips" }, ...[...new Set(msg.tools.map((t) => t.label))].map((l) => el("span", { class: "tool-chip", text: l })))
            : null,
          el("div", { class: "bubble" }, msg.error ? msg.content : markdown(msg.content)));
    log.append(node);
    node.scrollIntoView({ behavior: "smooth", block: "end" });
    return node;
  }

  function renderAll() {
    [...log.querySelectorAll(".msg")].forEach((n) => n.remove());
    $("empty").hidden = history.length > 0;
    history.forEach(addMessage);
  }

  async function ask(text) {
    const q = text.trim();
    if (!q || busy) return;
    busy = true;
    $("send-btn").disabled = true;
    history.push({ role: "user", content: q });
    persist();
    addMessage({ role: "user", content: q });
    input.value = "";
    autosize();
    const typing = el("div", { class: "msg msg-bot" }, el("div", { class: "bubble" }, el("span", { class: "typing", "aria-label": "Thinking" }, el("span"), el("span"), el("span"))));
    log.append(typing);
    typing.scrollIntoView({ behavior: "smooth", block: "end" });
    try {
      const res = await api("/api/assistant", { method: "POST", body: { messages: history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })) } });
      typing.remove();
      if (res.usageLeft) setLabel(null, res.usageLeft);
      const msg = { role: "assistant", content: res.reply, tools: res.tools };
      history.push(msg);
      persist();
      addMessage(msg);
    } catch (error) {
      typing.remove();
      addMessage({ role: "assistant", content: error.message, error: true });
      history.pop(); // let them retry the same question
      persist();
      input.value = q;
    } finally {
      busy = false;
      $("send-btn").disabled = false;
      input.focus();
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  $("suggestions").addEventListener("click", (e) => { if (e.target.closest(".chip")) ask(e.target.closest(".chip").textContent); });
  $("clear-btn").addEventListener("click", () => { history = []; persist(); renderAll(); input.focus(); });

  let status = null;
  function setLabel(s, usage) {
    status = s || status;
    if (!status) return;
    const u = usage || status.usage;
    $("model-label").textContent = !status.configured ? "Not set up"
      : `${status.label.replace(/ \(.*\)$/, "")} · ${status.model}${status.free ? " · free" : ""}${u && u.limitRequests ? ` · ${u.remainingRequests.toLocaleString("en-GB")}/${u.limitRequests.toLocaleString("en-GB")} today` : ""}`;
  }
  async function checkStatus() {
    const s = await api("/api/assistant/status").catch(() => null);
    if (!s) return;
    $("setup-card").hidden = s.configured;
    setLabel(s);
    input.disabled = !s.configured;
    $("send-btn").disabled = !s.configured;
    input.placeholder = s.configured ? "Ask about stock, quotes, quotas or what to order" : "Choose a model above to start";
    document.querySelectorAll("#suggestions .chip").forEach((c) => { c.disabled = !s.configured; });
    const o = s.ollama || {};
    $("ollama-pull").textContent = `ollama pull ${o.model || "qwen2.5:7b"}`;
    $("ollama-state").textContent = !o.running ? "Not running" : o.hasModel ? "Ready" : `Running · ${o.model} not downloaded`;
    $("ollama-state").className = `ai-state ${o.running && o.hasModel ? "is-good" : o.running ? "is-warn" : ""}`;
    document.querySelectorAll(".ai-key input, .ai-key button").forEach((x) => { x.disabled = !s.canEdit; });
  }
  $("ollama-check").addEventListener("click", checkStatus);
  document.querySelectorAll(".ai-key").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const provider = f.dataset.provider, key = f.elements.key.value.trim();
    if (!key) { f.elements.key.focus(); return; }
    try {
      await api("/api/settings", { method: "PUT", body: { assistantProvider: provider, [`${provider}ApiKey`]: key } });
      f.reset();
      toast("Saved. The assistant is ready.");
      await checkStatus();
      input.focus();
    } catch (error) { toast(error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message, true); }
  }));
  checkStatus();
  renderAll();
})();
