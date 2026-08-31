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

  // HMRC returns display strings like "Kilogram (kg)" — pull the short form.
  function shortUnit(raw) {
    if (!raw) return "";
    var s = String(raw).trim();
    var m = s.match(/\(([^)]+)\)/);
    if (m) return m[1].trim();
    return s;
  }

  // Convert to a display-friendly (value, unit) pair. Steel quotas come in kg
  // from HMRC; convert to tonnes for anything at or above 1 kg.
  function displayValue(value, raw) {
    if (value == null) return { text: "—", value: null };
    var unit = shortUnit(raw);
    var lower = unit.toLowerCase();
    if (lower === "kg" || lower === "kgm") {
      var tonnes = value / 1000;
      var rounded = tonnes >= 100 ? Math.round(tonnes) : Math.round(tonnes * 10) / 10;
      return { text: numberFormat.format(rounded) + " t", value: rounded };
    }
    return { text: numberFormat.format(Math.round(value)) + (unit ? " " + unit : ""), value: value };
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
    renderPressureBar(rows.length, counts);
  }

  function renderPressureBar(total, counts) {
    if (!total) return;
    ["open", "watch", "critical", "exhausted"].forEach(function (key) {
      var seg = document.querySelector('[data-pressure-seg="' + key + '"]');
      if (!seg) return;
      var pct = (counts[key] / total) * 100;
      seg.style.width = pct.toFixed(2) + "%";
      var label = seg.querySelector("span");
      if (label) label.textContent = pct >= 4 ? Math.round(pct) + "%" : "";
      seg.title = counts[key] + " " + key + " · " + pct.toFixed(1) + "%";
    });
    var caption = document.querySelector("[data-pressure-caption]");
    if (caption) {
      var underPressure = counts.watch + counts.critical + counts.exhausted;
      var underPct = ((underPressure / total) * 100).toFixed(1);
      caption.innerHTML =
        underPressure +
        " of " +
        total +
        " quotas are under pressure (Watch or worse) &mdash; " +
        underPct +
        "% of the regime";
    }
  }

  function setMetric(name, value) {
    var el = document.querySelector('[data-metric="' + name + '"]');
    if (el) el.textContent = numberFormat.format(value);
  }

  function fmtVolume(n, unit) {
    return displayValue(n, unit).text;
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
      var balanceText = displayValue(row.balance, row.measurementUnit).text;
      var initialText = displayValue(row.initialVolume, row.measurementUnit).text;
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

  // --- Quota calendar ---

  var todayLong = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  var dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

  function ukQuarter(today) {
    // Quota year starts 1 July. Quarters:
    // Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun.
    var y = today.getUTCFullYear();
    var m = today.getUTCMonth(); // 0-based
    var d = today.getUTCDate();
    var quotaYearStart;
    if (m >= 6) { // Jul (6) or later
      quotaYearStart = Date.UTC(y, 6, 1);
    } else {
      quotaYearStart = Date.UTC(y - 1, 6, 1);
    }
    var quotaYearEnd = Date.UTC(new Date(quotaYearStart).getUTCFullYear() + 1, 5, 30, 23, 59, 59);

    var quarters = [
      { n: 1, startM: 6, startY: 0, endM: 8, endD: 30, endY: 0, label: "Q1 · Jul–Sep" },
      { n: 2, startM: 9, startY: 0, endM: 11, endD: 31, endY: 0, label: "Q2 · Oct–Dec" },
      { n: 3, startM: 0, startY: 1, endM: 2, endD: 31, endY: 1, label: "Q3 · Jan–Mar" },
      { n: 4, startM: 3, startY: 1, endM: 5, endD: 30, endY: 1, label: "Q4 · Apr–Jun" },
    ];
    var startY = new Date(quotaYearStart).getUTCFullYear();
    var current = null;
    for (var i = 0; i < quarters.length; i++) {
      var q = quarters[i];
      var qStart = Date.UTC(startY + q.startY, q.startM, 1);
      var qEnd = Date.UTC(startY + q.endY, q.endM, q.endD, 23, 59, 59);
      if (today.getTime() >= qStart && today.getTime() <= qEnd) {
        current = { n: q.n, label: q.label, start: qStart, end: qEnd };
        break;
      }
    }
    return {
      quarter: current,
      quotaYearStart: quotaYearStart,
      quotaYearEnd: quotaYearEnd,
      quotaYearLabel: startY + "/" + String((startY + 1) % 100).padStart(2, "0"),
    };
  }

  function daysBetween(fromMs, toMs) {
    return Math.max(0, Math.ceil((toMs - fromMs) / (1000 * 60 * 60 * 24)));
  }

  function renderClock() {
    var today = new Date();
    var utcToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    var info = ukQuarter(utcToday);
    setText("today", todayLong.format(today));
    if (info.quarter) {
      setText("quarter", info.quarter.label + " · " + info.quotaYearLabel);
      setText("quarter-end", dayMonthYear.format(new Date(info.quarter.end)));
      var qDays = daysBetween(utcToday.getTime(), info.quarter.end);
      setText("quarter-countdown", qDays === 1 ? "1 day left" : qDays + " days left");
    }
    setText("year-end", dayMonthYear.format(new Date(info.quotaYearEnd)));
    var yDays = daysBetween(utcToday.getTime(), info.quotaYearEnd);
    setText("year-countdown", yDays === 1 ? "1 day left" : yDays + " days left");
  }

  function setText(key, value) {
    var el = document.querySelector('[data-clock="' + key + '"]');
    if (el) el.textContent = value;
  }

  renderClock();
  // Re-render the clock every hour so the "days left" value ticks down as
  // days pass without needing a page reload.
  setInterval(renderClock, 60 * 60 * 1000);

  fetchQuotas();
  setInterval(fetchQuotas, REFRESH_MS);
})();
