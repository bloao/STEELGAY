(function () {
  "use strict";
  var buttons = document.querySelectorAll(".site-nav__link--menu");
  if (!buttons.length) return;
  buttons.forEach(function (btn) {
    var dropdown = btn.closest(".site-nav__dropdown");
    if (!dropdown) return;
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = dropdown.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  });
  document.addEventListener("click", function () {
    document.querySelectorAll(".site-nav__dropdown.is-open").forEach(function (d) {
      d.classList.remove("is-open");
      var b = d.querySelector(".site-nav__link--menu");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      document.querySelectorAll(".site-nav__dropdown.is-open").forEach(function (d) {
        d.classList.remove("is-open");
      });
    }
  });
})();
