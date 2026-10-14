// Left-hand section menu for the order tool. Include right after an
// <aside class="sidebar" data-active="orders"></aside> so it renders
// before first paint.
(function () {
  "use strict";
  var aside = document.currentScript && document.currentScript.previousElementSibling;
  if (!aside || !aside.classList.contains("sidebar")) aside = document.querySelector("aside.sidebar");
  if (!aside) return;

  var ICONS = {
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
        { key: "orders", label: "Orders", href: "orders.html" },
        { key: "plan", label: "Plan an order", href: "plan.html" },
        { key: "assumptions", label: "Assumptions", href: "assumptions.html" },
        { key: "quotas", label: "Live quotas", href: "quotas.html" },
        { key: "arrivals", label: "Arrivals", href: "arrivals.html" },
      ] },
    { key: "products", label: "Products", href: "products.html", icon: "products" },
    { key: "suppliers", label: "Suppliers", href: "suppliers.html", icon: "suppliers", ownTabs: true,
      children: [
        { key: "suppliers", label: "Suppliers", href: "suppliers.html" },
        { key: "market-prices", label: "Market prices", href: "suppliers.html#market" },
      ] },
    { key: "market", label: "Market", href: "forecast.html", icon: "forecast", hint: "Where prices are heading and why",
      children: [
        { key: "forecast", label: "Steel forecast", href: "forecast.html" },
        { key: "news", label: "News & regulation", href: "news.html" },
        { key: "competition", label: "Competition", href: "competition.html" },
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
  function sectionLink(sec) {
    var on = inSection(sec);
    var html = '<li class="sidebar__sec' + (on ? " is-open" : "") + '"><a class="sidebar__link' + (on ? " is-active" : "") + '" href="' + sec.href + '"' +
      (on && !sec.children ? ' aria-current="page"' : "") + ">" + icon(sec.icon) + "<span>" + sec.label + "</span>" +
      (sec.children ? '<svg class="sidebar__chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>' : "") + "</a>";
    if (sec.children && on) {
      html += '<ul class="sidebar__sub">';
      sec.children.forEach(function (c) {
        var here = c.key === active;
        html += '<li><a class="sidebar__sublink' + (here ? " is-active" : "") + '" href="' + c.href + '"' + (here ? ' aria-current="page"' : "") + ">" + c.label + "</a></li>";
      });
      html += "</ul>";
    }
    return html + "</li>";
  }

  var html = '<nav class="sidebar__nav" aria-label="Order tool sections"><p class="sidebar__title">Procurement</p><ul>';
  SECTIONS.forEach(function (sec) { html += sectionLink(sec); });
  html += '</ul><button type="button" class="sidebar__intel" id="sidebar-intel">' +
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
    '<span>Log market intel</span></button>';
  html += '</nav><nav class="sidebar__foot" aria-label="Workspace"><ul>';
  FOOT.forEach(function (item) { html += sectionLink(item); });
  html += "</ul></nav>";

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
    aside.querySelectorAll(".sidebar__sublink").forEach(function (a) {
      var isMk = /#market$/.test(a.getAttribute("href"));
      a.classList.toggle("is-active", isMk === mk);
      if (isMk === mk) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  });
  aside.innerHTML = html;
  // The intel form loads on first use, so pages stay light.
  var btn = document.getElementById("sidebar-intel");
  if (btn) btn.addEventListener("click", function () {
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
