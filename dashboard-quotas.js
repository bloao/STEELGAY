(function () {
  "use strict";

  var REFRESH_MS = 5 * 60 * 1000;
  var TOP_N = 10;

  var listEl = document.querySelector("[data-quota-list]");
  var updatedEl = document.querySelector("[data-updated]");
  if (!listEl) return;

  var CATEGORY_LABELS = {
    "1": "Cat 1 · Hot-rolled sheets & strips",
    "4": "Cat 4 · Metallic-coated sheets",
    "5": "Cat 5 · Organic-coated sheets",
    "6": "Cat 6 · Tin mill products",
    "7": "Cat 7 · Quarto plate",
    "12A": "Cat 12A · Alloy merchant bars",
    "12B": "Cat 12B · Non-alloy merchant bars",
    "13": "Cat 13 · Rebar",
    "14": "Cat 14 · Stainless bars",
    "15": "Cat 15 · Stainless wire rod",
    "16": "Cat 16 · Wire rod",
    "17": "Cat 17 · Angles, shapes & sections",
    "19": "Cat 19 · Railway material",
    "20": "Cat 20 · Gas pipes",
    "21": "Cat 21 · Hollow sections",
    "25A": "Cat 25A · Large welded tubes",
    "25B": "Cat 25B · Large welded tubes",
    "26": "Cat 26 · Other welded tubes",
    "27": "Cat 27 · Cold-finished bars",
    "28": "Cat 28 · Non-alloy wire",
  };

  function shortUnit(raw) {
    if (!raw) return "";
    var s = String(raw).trim();
    var m = s.match(/\(([^)]+)\)/);
    return m ? m[1].trim() : s;
  }

  function displayValue(value, raw) {
    if (value == null) return "—";
    var unit = shortUnit(raw);
    var lower = unit.toLowerCase();
    if (lower === "kg" || lower === "kgm") {
      var tonnes = value / 1000;
      var rounded = tonnes >= 100 ? Math.round(tonnes) : Math.round(tonnes * 10) / 10;
      return numberFormat.format(rounded) + " t";
    }
    return numberFormat.format(Math.round(value)) + (unit ? " " + unit : "");
  }

  var numberFormat = new Intl.NumberFormat("en-GB");
  var pctFormat = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
  var dateFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });

  function statusFor(fill) {
    if (fill >= 1) return "exhausted";
    if (fill > 0.9) return "critical";
    if (fill >= 0.7) return "watch";
    return "open";
  }

  function statusLabel(s) {
    return { open: "Open", watch: "Watch", critical: "Critical", exhausted: "Exhausted" }[s];
  }

  function categoryLabel(row) {
    var ids = row.categoryIds || [];
    if (!ids.length) return row.description || "—";
    return ids.map(function (id) { return CATEGORY_LABELS[id] || ("Cat " + id); }).join(" · ");
  }


  function countryLabel(row) {
    var areas = row.geographicalAreas || [];
    if (!areas.length) return "Residual / other origins";
    if (areas.length > 2) return areas.slice(0, 2).join(", ") + " +" + (areas.length - 2);
    return areas.join(", ");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function setMetric(name, value) {
    var el = document.querySelector('[data-metric="' + name + '"]');
    if (el) el.textContent = numberFormat.format(value);
  }

  function renderSummary(rows) {
    var c = { open: 0, watch: 0, critical: 0, exhausted: 0 };
    rows.forEach(function (r) { c[statusFor(r.fillRate)]++; });
    setMetric("total", rows.length);
    setMetric("open", c.open);
    setMetric("watch", c.watch);
    setMetric("critical", c.critical);
    setMetric("exhausted", c.exhausted);
  }

  function renderTop(rows) {
    var sorted = rows.slice().sort(function (a, b) { return (b.fillRate || 0) - (a.fillRate || 0); });
    var top = sorted.slice(0, TOP_N);
    if (!top.length) {
      listEl.innerHTML = '<p class="dashboard-quotas__loading">No live quota rows returned.</p>';
      return;
    }
    var html =
      '<div class="dashboard-quotas__row dashboard-quotas__row--head">' +
        '<span>Category</span>' +
        '<span>Country / area</span>' +
        '<span class="num">Fill</span>' +
        '<span class="num">Balance</span>' +
        '<span>Status</span>' +
      '</div>' +
      top.map(function (row) {
        var s = statusFor(row.fillRate);
        var fill = Math.min(100, Math.max(0, (row.fillRate || 0) * 100));
        var usedLabel = fill >= 100 ? "100%" : pctFormat.format(fill) + "%";
        var remainingLabel = fill >= 100 ? "0% left" : pctFormat.format(100 - fill) + "% left";
        var balanceText = displayValue(row.balance, row.measurementUnit);
        return (
          '<a class="dashboard-quotas__row dashboard-quotas__row--' + s + '" href="quota-tracker.html">' +
            '<span class="dashboard-quotas__cat">' +
              '<strong>' + escapeHtml(categoryLabel(row).replace(/&amp;/g, "&")) + '</strong>' +
              '<em>' + escapeHtml(row.orderNumber || "") + '</em>' +
            '</span>' +
            '<span class="dashboard-quotas__country">' + escapeHtml(countryLabel(row)) + '</span>' +
            '<span class="num dashboard-quotas__fill">' +
              '<span class="dashboard-quotas__fill-bar">' +
                '<span class="dashboard-quotas__fill-fill" style="width:' + fill.toFixed(2) + '%"></span>' +
                '<span class="dashboard-quotas__fill-tick dashboard-quotas__fill-tick--watch"></span>' +
                '<span class="dashboard-quotas__fill-tick dashboard-quotas__fill-tick--critical"></span>' +
              '</span>' +
              '<span class="dashboard-quotas__fill-meta">' +
                '<em class="dashboard-quotas__fill-used">' + usedLabel + '</em>' +
                '<em class="dashboard-quotas__fill-left">' + remainingLabel + '</em>' +
              '</span>' +
            '</span>' +
            '<span class="num dashboard-quotas__balance">' + escapeHtml(balanceText) + '</span>' +
            '<span><span class="tracker-status tracker-status--' + s + '">' + statusLabel(s) + '</span></span>' +
          '</a>'
        );
      }).join("");
    listEl.innerHTML = html;
  }

  function renderUpdated(iso) {
    if (!updatedEl) return;
    if (!iso) { updatedEl.textContent = "—"; return; }
    var d = new Date(iso);
    updatedEl.textContent = timeFormat.format(d) + " · " + dateFormat.format(d);
  }

  function fetchQuotas() {
    fetch("/api/steel-quotas", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        var rows = data.rows || [];
        renderSummary(rows);
        renderTop(rows);
        renderUpdated(data.liveFetchedAt || new Date().toISOString());
      })
      .catch(function (err) {
        listEl.innerHTML = '<p class="dashboard-quotas__loading dashboard-quotas__loading--error">Could not load the live quota feed (' + err.message + '). Retrying automatically.</p>';
        if (updatedEl) updatedEl.textContent = "fetch failed";
      });
  }

  fetchQuotas();
  setInterval(fetchQuotas, REFRESH_MS);
})();
