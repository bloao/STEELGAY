// Page launcher for the order tool: a button that opens square tiles for every
// page, plus tabs across the top for the current section. Include right after an
// <aside class="sidebar" data-active="orders"></aside> so it renders
// before first paint.
(function () {
  "use strict";
  var aside = document.currentScript && document.currentScript.previousElementSibling;
  if (!aside || !aside.classList.contains("sidebar")) aside = document.querySelector("aside.sidebar");
  if (!aside) return;

  var ICONS = {
    plan: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 18h8"/>',
    assumptions: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    prices: '<path d="M20 12 12 20l-8-8V4h8z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    intel: '<path d="M12 5v14M5 12h14"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    orders: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2"/><path d="M9 11h6M9 15h6"/>',
    suppliers: '<path d="M3 21V10l5 3V10l5 3V6l8 4v11z"/><path d="M3 21h18"/><path d="M7 17h1M12 17h1M17 17h1"/>',
    products: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4"/><path d="M12 11v10"/>',
    quotas: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="m12 15 4-5"/><path d="M4 19h16"/>',
    assistant: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01M12 11h.01M15 11h.01"/>',
    market: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    news: '<path d="M4 5h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v10a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/>',
    competition: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15 14.5c.6-.2 1.3-.3 2-.3 2.2 0 4 1.8 4 4"/>',
    arrivals: '<path d="M3 17h18l-2 4H5z"/><path d="M6 17V9h8v8"/><path d="M14 12h4l2 5"/><path d="M9 9V5h3"/>',
    forecast: '<path d="M3 20h18"/><path d="M4 16l4-5 4 3 4-6"/><path d="M16 8h4v4" stroke-dasharray="2 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  // Five sections; related pages sit under them as sub-tabs (in the menu and
  // as tabs across the top of the page), because they feed into each other.
  var SECTIONS = [
    { key: "assistant", label: "Assistant", href: "assistant.html", icon: "assistant" },
    { key: "orders", label: "Orders", href: "orders.html", icon: "orders", hint: "What to buy, quota and what's on its way",
      children: [
        { key: "orders", label: "Orders", href: "orders.html", icon: "orders" },
        { key: "plan", label: "Plan an order", href: "plan.html", icon: "plan" },
        { key: "assumptions", label: "Assumptions", href: "assumptions.html", icon: "assumptions" },
        { key: "quotas", label: "Live quotas", href: "quotas.html", icon: "quotas" },
        { key: "arrivals", label: "Arrivals", href: "arrivals.html", icon: "arrivals" },
      ] },
    { key: "products", label: "Products", href: "products.html", icon: "products" },
    { key: "suppliers", label: "Suppliers", href: "suppliers.html", icon: "suppliers", ownTabs: true,
      children: [
        { key: "suppliers", label: "Suppliers", href: "suppliers.html", icon: "suppliers" },
        { key: "market-prices", label: "Market prices", href: "suppliers.html#market", icon: "prices" },
      ] },
    { key: "market", label: "Market", href: "forecast.html", icon: "forecast", hint: "Where prices are heading and why",
      children: [
        { key: "forecast", label: "Steel forecast", href: "forecast.html", icon: "forecast" },
        { key: "news", label: "News & regulation", href: "news.html", icon: "news" },
        { key: "competition", label: "Competition", href: "competition.html", icon: "competition" },
      ] },
  ];
  // Pinned to the bottom of the menu.
  var FOOT = [{ key: "settings", label: "Settings", href: "settings.html", icon: "settings" }];
  var active = aside.getAttribute("data-active");
  if (active === "suppliers" && location.hash === "#market") active = "market-prices";
  var inSection = function (sec) { return sec.key === active || (sec.children || []).some(function (c) { return c.key === active; }); };
  var current = null;
  SECTIONS.forEach(function (sec) { if (!current && inSection(sec)) current = sec; });

  function icon(name) {
    return '<svg class="sidebar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }
  // A small launcher: one button opens a pop-up of square tiles, grouped by section.
  function tile(item, extraCls) {
    var here = item.key === active;
    return '<a class="lt' + (here ? " is-active" : "") + (extraCls ? " " + extraCls : "") + '" href="' + item.href + '"' + (here ? ' aria-current="page"' : "") + ">" +
      icon(item.icon) + "<span>" + item.label + "</span></a>";
  }
  var groups = SECTIONS.map(function (sec) { return { label: sec.label, items: sec.children || [sec] }; });
  // Assistant sits with Settings and intel at the end
  var assistant = groups.filter(function (g) { return g.label === "Assistant"; })[0];
  groups = groups.filter(function (g) { return g !== assistant; });
  var cur = current ? (current.children ? (current.children.filter(function (c) { return c.key === active; })[0] || current) : current) : (FOOT.filter(function (f) { return f.key === active; })[0] || null);
  var html = '<button type="button" class="launcher-btn" id="launcher-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="launcher" title="Menu">' +
    icon("grid") + '<span class="launcher-cur">' + (cur ? cur.label : "Menu") + "</span></button>" +
    '<div class="launcher" id="launcher" role="dialog" aria-label="Pages" hidden><div class="launcher-groups">' +
    groups.map(function (g) {
      return '<section class="lg"><h2>' + g.label + '</h2><div class="lg-tiles">' + g.items.map(function (it) { return tile(it); }).join("") + "</div></section>";
    }).join("") +
    '<section class="lg"><h2>Workspace</h2><div class="lg-tiles">' +
      (assistant ? tile(assistant.items[0]) : "") + FOOT.map(function (f) { return tile(f); }).join("") +
      '<button type="button" class="lt is-intel" id="sidebar-intel">' + icon("intel") + "<span>Log market intel</span></button>" +
    "</div></section></div></div>";

  // Tabs across the top of the page for the current section's sub-pages.
  function sectionTabs() {
    if (!current || !current.children || current.ownTabs) return;
    var main = document.querySelector(".app-layout > main.page");
    if (!main || main.querySelector(".section-tabs")) return;
    var nav = document.createElement("nav");
    nav.className = "section-tabs";
    nav.setAttribute("aria-label", current.label + " sections");
    nav.innerHTML = current.children.map(function (c) {
      var here = c.key === active;
      return '<a href="' + c.href + '" class="section-tab' + (here ? " is-active" : "") + '"' + (here ? ' aria-current="page"' : "") + ">" + c.label + "</a>";
    }).join("");
    main.insertBefore(nav, main.firstChild);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sectionTabs); else sectionTabs();
  // Suppliers ↔ Market prices switch in place on the suppliers page
  window.addEventListener("hashchange", function () {
    if (aside.getAttribute("data-active") !== "suppliers") return;
    var mk = location.hash === "#market";
    aside.querySelectorAll(".lt[href^='suppliers.html']").forEach(function (a) {
      var isMk = /#market$/.test(a.getAttribute("href"));
      a.classList.toggle("is-active", isMk === mk);
      if (isMk === mk) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  });
  aside.innerHTML = html;
  aside.classList.add("is-launcher");
  var lbtn = document.getElementById("launcher-btn"), panel = document.getElementById("launcher");
  function setOpen(open) {
    panel.hidden = !open;
    lbtn.setAttribute("aria-expanded", String(open));
    if (open) { var a = panel.querySelector(".lt.is-active") || panel.querySelector(".lt"); if (a) a.focus(); }
  }
  lbtn.addEventListener("click", function () { setOpen(panel.hidden); });
  document.addEventListener("click", function (e) { if (!panel.hidden && !aside.contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) { setOpen(false); lbtn.focus(); } });
  // arrow keys move between tiles
  panel.addEventListener("keydown", function (e) {
    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].indexOf(e.key) < 0) return;
    var tiles = Array.prototype.slice.call(panel.querySelectorAll(".lt"));
    var i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 3 : -3;
    tiles[Math.max(0, Math.min(tiles.length - 1, i + step))].focus();
  });
  // The intel form loads on first use, so pages stay light.
  var btn = document.getElementById("sidebar-intel");
  if (btn) btn.addEventListener("click", function () {
    setOpen(false);
    if (window.MarketIntel) { window.MarketIntel.open({}); return; }
    var sc = document.createElement("script");
    sc.src = "intel.js";
    sc.onload = function () { if (window.MarketIntel) window.MarketIntel.open({}); };
    document.body.appendChild(sc);
  });
  window.openMarketIntel = function (pre) {
    if (window.MarketIntel) return window.MarketIntel.open(pre || {});
    var sc = document.createElement("script");
    sc.src = "intel.js";
    sc.onload = function () { if (window.MarketIntel) window.MarketIntel.open(pre || {}); };
    document.body.appendChild(sc);
  };
})();
