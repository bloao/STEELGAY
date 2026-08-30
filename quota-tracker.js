(function () {
  "use strict";

  var REFRESH_MS = 5 * 60 * 1000;
  var body = document.querySelector("[data-tracker-body]");
  if (!body) return;
  var searchInput = document.getElementById("q-search");
  var statusSelect = document.getElementById("q-status");
  var sortSelect = document.getElementById("q-sort");
  var updatedEl = document.querySelector("[data-updated]");
  var refreshBtn = document.querySelector("[data-refresh]");

  var state = {
    rows: [],
    fetchedAt: null,
    loading: false,
  };

  var CATEGORY_LABELS = {
    "1": "Cat 1 · Hot-rolled sheets & strips",
    "4": "Cat 4 · Metallic-coated sheets",
    "5": "Cat 5 · Organic-coated sheets",
    "6": "Cat 6 · Tin mill products",
    "7": "Cat 7 · Quarto plate",
    "12A": "Cat 12A · Alloy merchant bars / sections",
    "12B": "Cat 12B · Non-alloy merchant bars / sections",
    "13": "Cat 13 · Rebar",
    "14": "Cat 14 · Stainless bars / sections",
    "15": "Cat 15 · Stainless wire rod",
    "16": "Cat 16 · Non-alloy / alloy wire rod",
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

  var numberFormat = new Intl.NumberFormat("en-GB");
  var pctFormat = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var dateFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  var timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

  // Map HMRC / UN-ECE measurement-unit codes to something a buyer can read.
  var UNIT_MAP = {
    TNE: "tonnes",
    KGM: "kg",
    KG: "kg",
    "100 KGM": "100 kg",
    LTR: "L",
    MTQ: "m³",
    NAR: "items",
    PCE: "pieces",
    MTR: "m",
    HLT: "hl",
  };

  function formatUnit(code) {
    if (!code) return "";
    var trimmed = String(code).trim();
    if (UNIT_MAP[trimmed]) return UNIT_MAP[trimmed];
    if (UNIT_MAP[trimmed.toUpperCase()]) return UNIT_MAP[trimmed.toUpperCase()];
    return trimmed.toLowerCase();
  }

  function statusFor(fillRate) {
    if (fillRate >= 1) return "exhausted";
    if (fillRate > 0.9) return "critical";
    if (fillRate >= 0.7) return "watch";
    return "open";
  }

  function statusLabel(s) {
    return { open: "Open", watch: "Watch", critical: "Critical", exhausted: "Exhausted" }[s];
  }

  function categoryLabel(row) {
    var ids = row.categoryIds || [];
    if (!ids.length) return row.description || "&mdash;";
    var mapped = ids.map(function (id) { return CATEGORY_LABELS[id] || ("Cat " + id); });
    return mapped.join(" · ");
  }

  function periodLabel(row) {
    if (!row.startDate) return "&mdash;";
    try {
      var start = dateFormat.format(new Date(row.startDate));
      var end = row.endDate ? dateFormat.format(new Date(row.endDate)) : "";
      return start + (end ? " &rarr; " + end : "");
    } catch (e) {
      return row.startDate;
    }
  }

  function countryLabel(row) {
    var areas = row.geographicalAreas || [];
    if (!areas.length) return "Residual / other origins";
    if (areas.length > 3) return areas.slice(0, 3).join(", ") + " +" + (areas.length - 3);
    return areas.join(", ");
  }

  function fetchQuotas() {
    if (state.loading) return;
    state.loading = true;
    if (updatedEl) updatedEl.textContent = "Fetching…";
    fetch("/api/steel-quotas", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(function (data) {
        state.rows = data.rows || [];
        state.fetchedAt = data.liveFetchedAt || new Date().toISOString();
        state.loading = false;
        render();
      })
      .catch(function (err) {
        state.loading = false;
        body.innerHTML = '<tr><td colspan="8" class="tracker-table__empty tracker-table__empty--error">Could not fetch the live quota feed: ' + err.message + '. The tracker will retry automatically.</td></tr>';
        if (updatedEl) updatedEl.textContent = "Fetch failed";
      });
  }

  function filterAndSort(rows) {
    var query = (searchInput.value || "").toLowerCase().trim();
    var statusFilter = statusSelect.value;
    var sort = sortSelect.value;
    var filtered = rows.filter(function (row) {
      if (query) {
        var hay = (
          (row.orderNumber || "") +
          " " +
          (row.description || "") +
          " " +
          (row.geographicalAreas || []).join(" ") +
          " " +
          (row.categoryIds || []).join(" ") +
          " " +
          (row.commodityCodes || []).join(" ")
        ).toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      if (statusFilter !== "all") {
        var s = statusFor(row.fillRate);
        if (statusFilter === "pressure") {
          if (s !== "watch" && s !== "critical" && s !== "exhausted") return false;
        } else if (s !== statusFilter) {
          return false;
        }
      }
      return true;
    });
    filtered.sort(function (a, b) {
      switch (sort) {
        case "fill-asc": return (a.fillRate || 0) - (b.fillRate || 0);
        case "balance-asc": return (a.balance || 0) - (b.balance || 0);
        case "category": {
          var ca = (a.categoryIds || [])[0] || "z";
          var cb = (b.categoryIds || [])[0] || "z";
          return String(ca).localeCompare(String(cb), undefined, { numeric: true });
        }
        case "country": return (a.geographicalAreas || [])[0] ? a.geographicalAreas[0].localeCompare((b.geographicalAreas || [])[0] || "") : 1;
        case "fill-desc":
        default: return (b.fillRate || 0) - (a.fillRate || 0);
      }
    });
    return filtered;
  }

  function renderSummary(rows) {
    var counts = { open: 0, watch: 0, critical: 0, exhausted: 0 };
    rows.forEach(function (r) { counts[statusFor(r.fillRate)]++; });
    setMetric("total", rows.length);
    setMetric("open", counts.open);
    setMetric("watch", counts.watch);
    setMetric("critical", counts.critical);
    setMetric("exhausted", counts.exhausted);
  }

  function setMetric(name, value) {
    var el = document.querySelector('[data-metric="' + name + '"]');
    if (el) el.textContent = numberFormat.format(value);
  }

  function fmtVolume(n, unit) {
    if (n == null) return "&mdash;";
    var human = formatUnit(unit);
    var u = human ? " " + escapeHtml(human) : "";
    return numberFormat.format(Math.round(n)) + u;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderRows(rows) {
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="tracker-table__empty">No quotas match the current filters.</td></tr>';
      return;
    }
    var html = rows.map(function (row) {
      var s = statusFor(row.fillRate);
      var fill = Math.min(100, Math.max(0, (row.fillRate || 0) * 100));
      var pctUsedLabel = fill >= 100 ? "100%" : pctFormat.format(fill) + "%";
      var remainingPct = Math.max(0, 100 - fill);
      var remainingLabel = remainingPct === 0 ? "0% left" : pctFormat.format(remainingPct) + "% left";
      var unit = formatUnit(row.measurementUnit);
      var balanceText = row.balance != null ? numberFormat.format(Math.round(row.balance)) + (unit ? " " + unit : "") : "—";
      var initialText = row.initialVolume != null ? numberFormat.format(Math.round(row.initialVolume)) + (unit ? " " + unit : "") : "—";
      return (
        '<tr class="tracker-row tracker-row--' + s + '">' +
          '<td><span class="tracker-status tracker-status--' + s + '">' + statusLabel(s) + '</span></td>' +
          '<td><div class="tracker-category">' + escapeHtml(categoryLabel(row).replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/&mdash;/g, "—")) + '</div>' +
            (row.description ? '<div class="tracker-category__desc">' + escapeHtml(row.description) + '</div>' : "") +
          '</td>' +
          '<td class="mono">' + escapeHtml(row.orderNumber || "—") + '</td>' +
          '<td>' + escapeHtml(countryLabel(row)) + '</td>' +
          '<td class="num tracker-fill">' +
            '<div class="tracker-fill__bar">' +
              '<span class="tracker-fill__fill" style="width:' + fill.toFixed(2) + '%"></span>' +
              '<span class="tracker-fill__threshold tracker-fill__threshold--watch" title="Watch threshold (70%)"></span>' +
              '<span class="tracker-fill__threshold tracker-fill__threshold--critical" title="Critical threshold (90%)"></span>' +
            '</div>' +
            '<div class="tracker-fill__meta">' +
              '<span class="tracker-fill__used">' + pctUsedLabel + ' used</span>' +
              '<span class="tracker-fill__remaining">' + remainingLabel + '</span>' +
            '</div>' +
          '</td>' +
          '<td class="num">' + escapeHtml(balanceText) + '</td>' +
          '<td class="num">' + escapeHtml(initialText) + '</td>' +
          '<td class="mono">' + periodLabel(row) + '</td>' +
        '</tr>'
      );
    }).join("");
    body.innerHTML = html;
  }

  function renderUpdated() {
    if (!updatedEl) return;
    if (!state.fetchedAt) { updatedEl.textContent = "—"; return; }
    var d = new Date(state.fetchedAt);
    updatedEl.textContent = timeFormat.format(d) + " · " + dateFormat.format(d);
  }

  function render() {
    var filtered = filterAndSort(state.rows);
    renderSummary(state.rows);
    renderRows(filtered);
    renderUpdated();
  }

  if (searchInput) searchInput.addEventListener("input", render);
  if (statusSelect) statusSelect.addEventListener("change", render);
  if (sortSelect) sortSelect.addEventListener("change", render);
  if (refreshBtn) refreshBtn.addEventListener("click", function () { fetchQuotas(); });

  fetchQuotas();
  setInterval(fetchQuotas, REFRESH_MS);
})();
