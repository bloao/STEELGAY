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

  var CATEGORY_ORDER = ["1","4","5","6","7","12A","12B","13","14","15","16","17","19","20","21","25A","25B","26","27","28"];
  var CATEGORY_NAMES = {
    "1": "Hot-rolled sheets & strips",
    "4": "Metallic-coated sheets",
    "5": "Organic-coated sheets",
    "6": "Tin mill products",
    "7": "Quarto plate",
    "12A": "Alloy merchant bars & light sections",
    "12B": "Non-alloy merchant bars & light sections",
    "13": "Rebar",
    "14": "Stainless bars & light sections",
    "15": "Stainless wire rod",
    "16": "Non-alloy / alloy wire rod",
    "17": "Angles, shapes & sections",
    "19": "Railway material",
    "20": "Gas pipes",
    "21": "Hollow sections",
    "25A": "Large welded tubes",
    "25B": "Large welded tubes",
    "26": "Other welded tubes",
    "27": "Cold-finished bars",
    "28": "Non-alloy wire",
  };

  function primaryCat(row) {
    return (row.categoryIds || [])[0] || "?";
  }

  function shortDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
  }

  function burnPace(row) {
    if (!row.startDate || !row.endDate) return null;
    var start = new Date(row.startDate).getTime();
    var end = new Date(row.endDate).getTime();
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    var now = Date.now();
    if (now <= start) return null;
    var elapsed = Math.min(1, (now - start) / (end - start));
    if (elapsed <= 0.02) return null;
    return (row.fillRate || 0) / elapsed;
  }

  function burnLabel(pace) {
    if (pace == null) return "";
    if (pace < 0.9) return pctFormat.format(pace) + "× slower than even pace";
    if (pace <= 1.1) return "at an even pace";
    return pctFormat.format(pace) + "× burn pace";
  }

  function renderRows(rows) {
    if (!rows.length) {
      body.innerHTML = '<p class="tracker-categories__loading">No quotas match the current filters.</p>';
      return;
    }
    var groups = {};
    var order = [];
    rows.forEach(function (row) {
      var cat = primaryCat(row);
      if (!groups[cat]) { groups[cat] = []; order.push(cat); }
      groups[cat].push(row);
    });
    order.sort(function (a, b) {
      var ai = CATEGORY_ORDER.indexOf(a);
      var bi = CATEGORY_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return String(a).localeCompare(String(b), undefined, { numeric: true });
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    var html = order.map(function (cat) {
      var lines = groups[cat];
      var totalInitial = lines.reduce(function (s, r) { return s + (r.initialVolume || 0); }, 0);
      var totalBalance = lines.reduce(function (s, r) { return s + (r.balance || 0); }, 0);
      var unitCode = lines[0] && lines[0].measurementUnit;
      var initialTxt = displayValue(totalInitial, unitCode).text;
      var balanceTxt = displayValue(totalBalance, unitCode).text;
      var aggFillPct = totalInitial > 0 ? (1 - totalBalance / totalInitial) * 100 : 0;
      var aggStatus = statusFor(aggFillPct / 100);
      lines.sort(function (a, b) {
        var f = (b.fillRate || 0) - (a.fillRate || 0);
        if (f !== 0) return f;
        return String(countryLabel(a)).localeCompare(String(countryLabel(b)));
      });
      var name = CATEGORY_NAMES[cat] || (lines[0] && lines[0].description) || "";

      var linesHtml = lines.map(function (row) {
        var s = statusFor(row.fillRate);
        var fill = Math.min(100, Math.max(0, (row.fillRate || 0) * 100));
        var pctUsed = fill >= 100 ? "100%" : pctFormat.format(fill) + "%";
        var lineBal = displayValue(row.balance, row.measurementUnit).text;
        var lineInit = displayValue(row.initialVolume, row.measurementUnit).text;
        var pace = burnPace(row);
        var paceTxt = burnLabel(pace);
        var lastAlloc = shortDate(row.lastAllocationDate);
        var metaBits = [pctUsed + " used"];
        if (lastAlloc) metaBits.push("last allocation " + lastAlloc);
        if (paceTxt) metaBits.push(paceTxt);
        var extLink = row.orderNumber
          ? ' <a class="tracker-line__ext" href="https://www.trade-tariff.service.gov.uk/quota_search?order_number=' + encodeURIComponent(row.orderNumber) + '" target="_blank" rel="noopener" aria-label="Open on the UK Trade Tariff">&#8599;</a>'
          : "";
        return (
          '<article class="tracker-line tracker-line--' + s + '">' +
            '<div class="tracker-line__head">' +
              '<div class="tracker-line__area">' + escapeHtml(countryLabel(row)) + '</div>' +
              '<div class="tracker-line__order">#' + escapeHtml(row.orderNumber || "—") + extLink + '</div>' +
              '<span class="tracker-status tracker-status--' + s + '">' + statusLabel(s) + '</span>' +
            '</div>' +
            '<div class="tracker-line__balance"><strong>' + escapeHtml(lineBal) + '</strong> left of ' + escapeHtml(lineInit) + '</div>' +
            '<div class="tracker-line__bar">' +
              '<span class="tracker-line__bar-fill" style="width:' + fill.toFixed(2) + '%"></span>' +
              '<span class="tracker-line__bar-tick tracker-line__bar-tick--watch"></span>' +
              '<span class="tracker-line__bar-tick tracker-line__bar-tick--critical"></span>' +
            '</div>' +
            '<div class="tracker-line__meta">' + metaBits.join(' &middot; ') + '</div>' +
          '</article>'
        );
      }).join("");

      return (
        '<article class="tracker-cat tracker-cat--' + aggStatus + '">' +
          '<header class="tracker-cat__head">' +
            '<div class="tracker-cat__ident">' +
              '<span class="tracker-cat__code">Cat ' + escapeHtml(cat) + '</span>' +
              '<h3 class="tracker-cat__name">' + escapeHtml(name.replace(/&amp;/g, "&")) + '</h3>' +
              '<p class="tracker-cat__summary"><strong>' + escapeHtml(balanceTxt) + '</strong> remaining of ' + escapeHtml(initialTxt) + ' across ' + lines.length + ' quota line' + (lines.length === 1 ? '' : 's') + '</p>' +
            '</div>' +
            '<div class="tracker-cat__meta">' +
              '<span class="tracker-cat__pct">' + pctFormat.format(aggFillPct) + '%</span>' +
              '<em>used across all lines</em>' +
            '</div>' +
          '</header>' +
          '<div class="tracker-cat__lines">' + linesHtml + '</div>' +
        '</article>'
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
