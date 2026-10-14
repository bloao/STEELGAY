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
    forecast: '<path d="M3 20h18"/><path d="M4 16l4-5 4 3 4-6"/><path d="M16 8h4v4" stroke-dasharray="2 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  var ITEMS = [
    { key: "assistant", label: "Assistant", href: "assistant.html" },
    { key: "orders", label: "Orders", href: "orders.html" },
    { key: "products", label: "Products", href: "products.html" },
    { key: "suppliers", label: "Suppliers", href: "suppliers.html" },
    { key: "quotas", label: "Live quotas", href: "quotas.html" },
    { key: "news", label: "Market news", href: "news.html" },
    { key: "forecast", label: "Steel forecast", href: "forecast.html" },
  ];
  // Pinned to the bottom of the menu.
  var FOOT = [{ key: "settings", label: "Settings", href: "settings.html" }];
  var active = aside.getAttribute("data-active");

  function link(item) {
    var current = item.key === active;
    return '<li><a class="sidebar__link' + (current ? " is-active" : "") + '" href="' + item.href + '"' +
      (current ? ' aria-current="page"' : "") + '>' +
      '<svg class="sidebar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[item.key] + "</svg><span>" + item.label + "</span></a></li>";
  }

  var html = '<nav class="sidebar__nav" aria-label="Order tool sections"><p class="sidebar__title">Procurement</p><ul>';
  ITEMS.forEach(function (item) { html += link(item); });
  html += '</ul></nav><nav class="sidebar__foot" aria-label="Workspace"><ul>';
  FOOT.forEach(function (item) { html += link(item); });
  html += "</ul></nav>";
  aside.innerHTML = html;
})();
