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
  };
  var ITEMS = [
    { key: "orders", label: "Orders", href: "orders.html" },
    { key: "suppliers", label: "Suppliers", href: "suppliers.html" },
    { key: "products", label: "Products", href: "products.html" },
    { key: "quotas", label: "Live quotas", href: "quotas.html" },
    { key: "assistant", label: "Assistant", href: "assistant.html" },
  ];
  var active = aside.getAttribute("data-active");

  var html = '<nav class="sidebar__nav" aria-label="Order tool sections"><p class="sidebar__title">Procurement</p><ul>';
  ITEMS.forEach(function (item) {
    var current = item.key === active;
    html += '<li><a class="sidebar__link' + (current ? " is-active" : "") + '" href="' + item.href + '"' +
      (current ? ' aria-current="page"' : "") + '>' +
      '<svg class="sidebar__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[item.key] + "</svg><span>" + item.label + "</span></a></li>";
  });
  html += "</ul></nav>";
  aside.innerHTML = html;
})();
