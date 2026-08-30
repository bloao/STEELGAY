(function () {
  "use strict";

  var STORAGE_HIGHLIGHTS = "primer.highlights.v1";
  var STORAGE_COMMENTS = "primer.comments.v1";
  var ROOT = document.querySelector(".primer-article");
  if (!ROOT) return;

  var mode = null; // null | "highlight" | "comment"
  var activePopover = null;

  // ----- Storage helpers -----

  function safeParse(json, fallback) {
    try {
      var v = JSON.parse(json);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function loadHighlights() {
    return safeParse(localStorage.getItem(STORAGE_HIGHLIGHTS), []);
  }
  function saveHighlights(list) {
    localStorage.setItem(STORAGE_HIGHLIGHTS, JSON.stringify(list));
  }
  function loadComments() {
    return safeParse(localStorage.getItem(STORAGE_COMMENTS), []);
  }
  function saveComments(list) {
    localStorage.setItem(STORAGE_COMMENTS, JSON.stringify(list));
  }

  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  // ----- Anchor blocks (for comments) -----

  function assignAnchorIds() {
    var blocks = ROOT.querySelectorAll(
      "section > p, section > ul, section > ol, section > h2, section > h3, section > div"
    );
    blocks.forEach(function (el, i) {
      if (!el.dataset.anchorId) el.dataset.anchorId = "blk-" + i;
      el.classList.add("primer-anchor");
    });
  }

  // ----- Character-offset helpers within a section -----

  function findAncestorSection(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    while (el && el !== ROOT) {
      if (el.tagName === "SECTION" && el.id) return el;
      el = el.parentNode;
    }
    return null;
  }

  // A text node counts toward character offsets only when it's part of the
  // article's own content. Pin buttons, popovers and the reveal-clone shims
  // that live inside a section must be excluded so offsets stay stable
  // whether or not those elements happen to be attached right now.
  function isCountableTextNode(node, root) {
    var p = node.parentNode;
    while (p && p !== root) {
      if (p.classList) {
        if (
          p.classList.contains("comment-pin") ||
          p.classList.contains("primer-toolbar") ||
          p.classList.contains("primer-notes") ||
          p.classList.contains("primer-popover") ||
          p.classList.contains("primer-toast")
        ) {
          return false;
        }
      }
      p = p.parentNode;
    }
    return true;
  }

  function makeContentWalker(root, opts) {
    opts = opts || {};
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!isCountableTextNode(node, root)) return NodeFilter.FILTER_REJECT;
        if (opts.skipHighlights) {
          var p = node.parentNode;
          while (p && p !== root) {
            if (p.classList && p.classList.contains("user-highlight")) return NodeFilter.FILTER_REJECT;
            p = p.parentNode;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  function charOffsetInRoot(root, container, offset) {
    if (container.nodeType === 3) {
      var walker = makeContentWalker(root);
      var total = 0;
      var node;
      while ((node = walker.nextNode())) {
        if (node === container) return total + offset;
        total += node.nodeValue.length;
      }
      return total;
    }
    // Element container: sum text up to the child at `offset`
    var w2 = makeContentWalker(root);
    var sum = 0;
    var n2;
    var stop = container.childNodes[offset] || null;
    while ((n2 = w2.nextNode())) {
      if (stop && (n2 === stop || (stop.contains && stop.contains(n2)))) return sum;
      sum += n2.nodeValue.length;
    }
    return sum;
  }

  function wrapCharRange(root, startOff, endOff, tagName, className, dataAttrs) {
    var walker = makeContentWalker(root, { skipHighlights: true });
    var pos = 0;
    var pieces = [];
    var node;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      var nodeStart = pos;
      var nodeEnd = pos + len;
      if (nodeEnd > startOff && nodeStart < endOff) {
        var s = Math.max(0, startOff - nodeStart);
        var e = Math.min(len, endOff - nodeStart);
        pieces.push({ node: node, s: s, e: e });
      }
      pos = nodeEnd;
      if (pos >= endOff) break;
    }
    var wrapped = [];
    pieces.forEach(function (p) {
      var node = p.node;
      var before = node.nodeValue.slice(0, p.s);
      var middle = node.nodeValue.slice(p.s, p.e);
      var after = node.nodeValue.slice(p.e);
      var mark = document.createElement(tagName);
      mark.className = className;
      if (dataAttrs) {
        Object.keys(dataAttrs).forEach(function (k) {
          mark.dataset[k] = dataAttrs[k];
        });
      }
      mark.textContent = middle;
      var parent = node.parentNode;
      if (after.length) parent.insertBefore(document.createTextNode(after), node.nextSibling);
      parent.insertBefore(mark, node.nextSibling);
      if (before.length) node.nodeValue = before;
      else parent.removeChild(node);
      wrapped.push(mark);
    });
    return wrapped;
  }

  // ----- Highlight rendering -----

  function renderHighlights() {
    // Remove any existing highlight marks first (idempotent re-render)
    ROOT.querySelectorAll("mark.user-highlight").forEach(unwrapMark);
    var list = loadHighlights();
    list.forEach(function (h) {
      var section = document.getElementById(h.sectionId);
      if (!section) return;
      var marks = wrapCharRange(section, h.startOffset, h.endOffset, "mark", "user-highlight", { hid: h.id });
      if (marks.length === 0) return;
      // Add title for context on hover
      marks.forEach(function (m) {
        m.setAttribute("title", "Click to remove highlight");
      });
    });
  }

  function unwrapMark(mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function handleNewHighlightFromSelection() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var text = range.toString().trim();
    if (!text) return;
    var section = findAncestorSection(range.commonAncestorContainer);
    if (!section) return;
    // Ensure both endpoints are inside the same section
    if (!section.contains(range.startContainer) || !section.contains(range.endContainer)) return;
    var startOffset = charOffsetInRoot(section, range.startContainer, range.startOffset);
    var endOffset = charOffsetInRoot(section, range.endContainer, range.endOffset);
    if (endOffset <= startOffset) return;
    var h = {
      id: uid("h"),
      sectionId: section.id,
      startOffset: startOffset,
      endOffset: endOffset,
      text: text.slice(0, 200),
      createdAt: Date.now(),
    };
    var list = loadHighlights();
    list.push(h);
    saveHighlights(list);
    sel.removeAllRanges();
    renderHighlights();
    refreshSidebar();
    toast("Highlight saved");
  }

  function removeHighlightById(id) {
    var list = loadHighlights().filter(function (h) {
      return h.id !== id;
    });
    saveHighlights(list);
    renderHighlights();
    refreshSidebar();
  }

  // ----- Comment pins -----

  function renderComments() {
    ROOT.querySelectorAll(".comment-pin").forEach(function (n) {
      n.parentNode.removeChild(n);
    });
    var list = loadComments();
    list.forEach(function (c) {
      var anchor = ROOT.querySelector('[data-anchor-id="' + cssEscape(c.anchorId) + '"]');
      if (!anchor) return;
      var pin = document.createElement("button");
      pin.type = "button";
      pin.className = "comment-pin";
      pin.dataset.cid = c.id;
      pin.setAttribute("aria-label", "Open comment");
      pin.textContent = commentIndex(c.id) + "";
      anchor.appendChild(pin);
    });
  }

  function commentIndex(id) {
    var list = loadComments();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i + 1;
    return 0;
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  function addCommentAt(target) {
    // target: any element inside a .primer-anchor block
    var anchor = target;
    while (anchor && !anchor.classList.contains("primer-anchor")) anchor = anchor.parentNode;
    if (!anchor || !anchor.dataset.anchorId) return;
    var text = window.prompt("Add a comment for this section:", "");
    if (text == null) return;
    var trimmed = text.trim();
    if (!trimmed) return;
    var section = anchor.closest("section");
    var c = {
      id: uid("c"),
      anchorId: anchor.dataset.anchorId,
      sectionId: section ? section.id : "",
      sectionTitle: section ? sectionTitle(section) : "",
      contextText: anchor.textContent.trim().slice(0, 120),
      text: trimmed,
      createdAt: Date.now(),
    };
    var list = loadComments();
    list.push(c);
    saveComments(list);
    renderComments();
    refreshSidebar();
    toast("Comment saved");
  }

  function removeCommentById(id) {
    var list = loadComments().filter(function (c) {
      return c.id !== id;
    });
    saveComments(list);
    renderComments();
    refreshSidebar();
  }

  function editComment(id) {
    var list = loadComments();
    var c = list.find(function (x) {
      return x.id === id;
    });
    if (!c) return;
    var text = window.prompt("Edit comment:", c.text);
    if (text == null) return;
    var trimmed = text.trim();
    if (!trimmed) return removeCommentById(id);
    c.text = trimmed;
    c.updatedAt = Date.now();
    saveComments(list);
    refreshSidebar();
  }

  function sectionTitle(section) {
    var h = section.querySelector("h2");
    return h ? h.textContent.trim() : section.id;
  }

  // ----- Popover for highlight & comment interactions -----

  function closePopover() {
    if (activePopover && activePopover.parentNode) activePopover.parentNode.removeChild(activePopover);
    activePopover = null;
  }

  function showHighlightPopover(mark) {
    closePopover();
    var pop = document.createElement("div");
    pop.className = "primer-popover primer-popover--highlight";
    pop.innerHTML =
      '<button type="button" data-act="remove">Remove highlight</button>';
    positionPopover(pop, mark);
    document.body.appendChild(pop);
    activePopover = pop;
    pop.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "remove") {
        removeHighlightById(mark.dataset.hid);
        closePopover();
      }
    });
  }

  function showCommentPopover(pin) {
    closePopover();
    var list = loadComments();
    var c = list.find(function (x) {
      return x.id === pin.dataset.cid;
    });
    if (!c) return;
    var pop = document.createElement("div");
    pop.className = "primer-popover primer-popover--comment";
    pop.innerHTML =
      '<div class="primer-popover__body"></div>' +
      '<div class="primer-popover__actions">' +
      '<button type="button" data-act="edit">Edit</button>' +
      '<button type="button" data-act="delete">Delete</button>' +
      "</div>";
    pop.querySelector(".primer-popover__body").textContent = c.text;
    positionPopover(pop, pin);
    document.body.appendChild(pop);
    activePopover = pop;
    pop.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit") {
        closePopover();
        editComment(c.id);
      } else if (btn.dataset.act === "delete") {
        removeCommentById(c.id);
        closePopover();
      }
    });
  }

  function positionPopover(pop, anchorEl) {
    pop.style.position = "absolute";
    pop.style.visibility = "hidden";
    document.body.appendChild(pop);
    var rect = anchorEl.getBoundingClientRect();
    var scrollY = window.pageYOffset || document.documentElement.scrollTop;
    var scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    var popRect = pop.getBoundingClientRect();
    var left = rect.left + scrollX + Math.max(0, (rect.width - popRect.width) / 2);
    var top = rect.bottom + scrollY + 8;
    // Keep within viewport horizontally
    left = Math.max(12 + scrollX, Math.min(left, scrollX + document.documentElement.clientWidth - popRect.width - 12));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.style.visibility = "";
  }

  // ----- Toolbar & sidebar -----

  function buildToolbar() {
    var t = document.createElement("div");
    t.className = "primer-toolbar";
    t.innerHTML =
      '<button type="button" class="primer-toolbar__btn" data-tool="highlight" title="Highlight text (click, then select text)">' +
      '<span class="primer-toolbar__icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4l5 5-9 9H6v-5l9-9z"/><path d="M11 8l5 5"/></svg>' +
      "</span>" +
      '<span class="primer-toolbar__label">Highlight</span>' +
      "</button>" +
      '<button type="button" class="primer-toolbar__btn" data-tool="comment" title="Add a comment (click, then click a section)">' +
      '<span class="primer-toolbar__icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      "</span>" +
      '<span class="primer-toolbar__label">Comment</span>' +
      "</button>" +
      '<button type="button" class="primer-toolbar__btn" data-tool="notes" title="Open my notes">' +
      '<span class="primer-toolbar__icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>' +
      "</span>" +
      '<span class="primer-toolbar__label">My notes</span>' +
      '<span class="primer-toolbar__count" data-count>0</span>' +
      "</button>";
    document.body.appendChild(t);
    t.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-tool]");
      if (!btn) return;
      var tool = btn.dataset.tool;
      if (tool === "notes") {
        toggleSidebar();
        return;
      }
      setMode(mode === tool ? null : tool);
    });
    return t;
  }

  function setMode(newMode) {
    mode = newMode;
    document.body.classList.toggle("primer-mode-highlight", mode === "highlight");
    document.body.classList.toggle("primer-mode-comment", mode === "comment");
    document.querySelectorAll(".primer-toolbar__btn").forEach(function (b) {
      var isActive = b.dataset.tool && b.dataset.tool === mode;
      b.classList.toggle("is-active", !!isActive);
    });
    if (mode === "highlight") toast("Highlight mode on — select any text");
    else if (mode === "comment") toast("Comment mode on — click a paragraph, heading or step");
    else closePopover();
  }

  function buildSidebar() {
    var s = document.createElement("aside");
    s.className = "primer-notes";
    s.innerHTML =
      '<header class="primer-notes__head">' +
      '<div><strong>My notes</strong><span class="primer-notes__hint">Saved on this device</span></div>' +
      '<button type="button" class="primer-notes__close" aria-label="Close notes">&times;</button>' +
      "</header>" +
      '<div class="primer-notes__tabs">' +
      '<button type="button" class="primer-notes__tab is-active" data-pane="highlights">Highlights <span data-count-h>0</span></button>' +
      '<button type="button" class="primer-notes__tab" data-pane="comments">Comments <span data-count-c>0</span></button>' +
      "</div>" +
      '<div class="primer-notes__body">' +
      '<section class="primer-notes__list is-active" data-pane="highlights"></section>' +
      '<section class="primer-notes__list" data-pane="comments"></section>' +
      '<button type="button" class="primer-notes__clear" data-act="clear-all">Clear all notes on this page</button>' +
      "</div>";
    document.body.appendChild(s);
    s.addEventListener("click", function (e) {
      var tab = e.target.closest(".primer-notes__tab");
      if (tab) {
        s.querySelectorAll(".primer-notes__tab").forEach(function (b) {
          b.classList.toggle("is-active", b === tab);
        });
        s.querySelectorAll(".primer-notes__list").forEach(function (list) {
          list.classList.toggle("is-active", list.dataset.pane === tab.dataset.pane);
        });
        return;
      }
      var close = e.target.closest(".primer-notes__close");
      if (close) return toggleSidebar(false);
      var clear = e.target.closest("[data-act=clear-all]");
      if (clear) {
        if (window.confirm("Delete every highlight and comment on this page?")) {
          saveHighlights([]);
          saveComments([]);
          renderHighlights();
          renderComments();
          refreshSidebar();
        }
        return;
      }
      var row = e.target.closest("[data-item-id]");
      if (row) {
        if (e.target.closest("[data-item-act=delete]")) {
          var kind = row.dataset.itemKind;
          if (kind === "h") removeHighlightById(row.dataset.itemId);
          else if (kind === "c") removeCommentById(row.dataset.itemId);
          return;
        }
        scrollToItem(row.dataset.itemKind, row.dataset.itemId);
      }
    });
    return s;
  }

  function toggleSidebar(force) {
    var s = document.querySelector(".primer-notes");
    if (!s) return;
    var open = typeof force === "boolean" ? force : !s.classList.contains("is-open");
    s.classList.toggle("is-open", open);
    document.body.classList.toggle("primer-notes-open", open);
  }

  function refreshSidebar() {
    var s = document.querySelector(".primer-notes");
    if (!s) return;
    var hs = loadHighlights();
    var cs = loadComments();
    s.querySelector("[data-count-h]").textContent = hs.length;
    s.querySelector("[data-count-c]").textContent = cs.length;
    var tCount = document.querySelector(".primer-toolbar__count");
    if (tCount) tCount.textContent = hs.length + cs.length;
    var hList = s.querySelector('.primer-notes__list[data-pane="highlights"]');
    var cList = s.querySelector('.primer-notes__list[data-pane="comments"]');
    hList.innerHTML = "";
    cList.innerHTML = "";
    if (!hs.length) hList.innerHTML = '<p class="primer-notes__empty">No highlights yet. Turn on the highlighter and select text.</p>';
    if (!cs.length) cList.innerHTML = '<p class="primer-notes__empty">No comments yet. Turn on Comment mode and click any block.</p>';
    hs.forEach(function (h) {
      var el = document.createElement("div");
      el.className = "primer-notes__row";
      el.dataset.itemId = h.id;
      el.dataset.itemKind = "h";
      el.innerHTML =
        '<div class="primer-notes__row-body"><span class="primer-notes__quote"></span>' +
        '<span class="primer-notes__meta"></span></div>' +
        '<button type="button" class="primer-notes__row-del" data-item-act="delete" aria-label="Delete">&times;</button>';
      el.querySelector(".primer-notes__quote").textContent = "“" + h.text + "”";
      el.querySelector(".primer-notes__meta").textContent = sectionTitleFor(h.sectionId) + " · " + formatDate(h.createdAt);
      hList.appendChild(el);
    });
    cs.forEach(function (c, i) {
      var el = document.createElement("div");
      el.className = "primer-notes__row";
      el.dataset.itemId = c.id;
      el.dataset.itemKind = "c";
      el.innerHTML =
        '<div class="primer-notes__row-body">' +
        '<span class="primer-notes__num"></span>' +
        '<span class="primer-notes__text"></span>' +
        '<span class="primer-notes__meta"></span>' +
        "</div>" +
        '<button type="button" class="primer-notes__row-del" data-item-act="delete" aria-label="Delete">&times;</button>';
      el.querySelector(".primer-notes__num").textContent = i + 1;
      el.querySelector(".primer-notes__text").textContent = c.text;
      el.querySelector(".primer-notes__meta").textContent =
        (c.sectionTitle || sectionTitleFor(c.sectionId)) + " · " + formatDate(c.createdAt);
      cList.appendChild(el);
    });
  }

  function sectionTitleFor(id) {
    var s = document.getElementById(id);
    return s ? sectionTitle(s) : id;
  }

  function formatDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  function scrollToItem(kind, id) {
    var el = null;
    if (kind === "h") el = ROOT.querySelector('mark.user-highlight[data-hid="' + cssEscape(id) + '"]');
    else if (kind === "c") el = ROOT.querySelector('.comment-pin[data-cid="' + cssEscape(id) + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("primer-flash");
    setTimeout(function () { el.classList.remove("primer-flash"); }, 1200);
  }

  // ----- Toast -----

  var toastTimer = null;
  function toast(text) {
    var el = document.querySelector(".primer-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "primer-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("is-visible");
    }, 1600);
  }

  // ----- Event wiring -----

  document.addEventListener("mouseup", function (e) {
    if (mode !== "highlight") return;
    // Ignore clicks on toolbar / sidebar
    if (e.target.closest(".primer-toolbar, .primer-notes, .primer-popover")) return;
    setTimeout(handleNewHighlightFromSelection, 0);
  });

  document.addEventListener("click", function (e) {
    // Highlight interaction: click on existing highlight → popover
    var mark = e.target.closest("mark.user-highlight");
    if (mark && !e.target.closest(".primer-toolbar, .primer-notes, .primer-popover")) {
      e.preventDefault();
      showHighlightPopover(mark);
      return;
    }
    // Comment pin click → popover (ignore in comment mode to avoid double-trigger)
    var pin = e.target.closest(".comment-pin");
    if (pin) {
      e.preventDefault();
      e.stopPropagation();
      showCommentPopover(pin);
      return;
    }
    // Comment mode: click anywhere in article body → attach comment to nearest block
    if (mode === "comment") {
      if (e.target.closest(".primer-toolbar, .primer-notes, .primer-popover, .comment-pin")) return;
      var t = e.target.closest(".primer-article .primer-anchor");
      if (!t || !ROOT.contains(t)) return;
      e.preventDefault();
      addCommentAt(t);
      return;
    }
    // Click outside active popover closes it
    if (activePopover && !e.target.closest(".primer-popover")) closePopover();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      setMode(null);
      closePopover();
      toggleSidebar(false);
    }
  });

  // ----- Init -----

  assignAnchorIds();
  renderHighlights();
  renderComments();
  buildToolbar();
  buildSidebar();
  refreshSidebar();
})();
