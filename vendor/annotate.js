/* Annotation pop-up (opt-in, claudeCodeKatex.annotate): select text in a
 * Claude reply, type a note in the pop-up, and the quoted span plus the note
 * are inserted into the prompt box. Each annotated span keeps a numbered
 * balloon; clicking it reopens the note for editing, with a button to delete
 * the whole annotation.
 *
 * Plain DOM code prepended to Claude Code's webview bundle. It never touches
 * React state directly: the prompt box is a contentEditable="plaintext-only"
 * div whose React onInput handler reads textContent, so text goes in as text
 * nodes followed by an input event (see insertIntoComposer). The prompt box
 * is the single source of truth for the notes; the balloons only point at it
 * by annotation number. */
(function () {
  if (window.__CCA_LOADED) return;
  window.__CCA_LOADED = true;

  var COMPOSER = '[role="textbox"][aria-label="Message input"]';
  // CSS-module class names carry a per-build hash suffix; match on the prefix.
  var SCOPE = '[class*="messagesContainer_"]';
  var EXCLUDE = '[class*="userMessage_"],[contenteditable],textarea,input,.cca-pop,.cca-badge';
  var HL_NOTED = 'cca-noted';
  var HL_PENDING = 'cca-pending';
  var HL_LABEL = 'cca-label';
  // Label lines drawn bold in the prompt box and in sent messages.
  var LABEL_RE = /^(?:Annotation \d+:|My comment:)[ \t]*$/gm;
  var COMMENT_LINE = /^My comment:[ \t]*$/;

  var pop = null;       // the open pop-up, if any
  var popRange = null;  // the range the open pop-up annotates
  var popEdit = null;   // the annotation being edited, or null when adding
  var annots = [];      // { n, range, badge } for each note in the prompt box

  function closestEl(node, sel) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest(sel) : null;
  }

  function supportsHighlights() {
    return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  }

  function connected(range) {
    return range.startContainer.isConnected && range.endContainer.isConnected;
  }

  function paint() {
    if (!supportsHighlights()) return;
    var h = new Highlight();
    annots.forEach(function (a) { if (connected(a.range)) h.add(a.range); });
    CSS.highlights.set(HL_NOTED, h);
    if (popRange && !popEdit) CSS.highlights.set(HL_PENDING, new Highlight(popRange));
    else CSS.highlights.delete(HL_PENDING);
  }

  // Outermost rendered-math element containing node: a display block when
  // there is one, else the inline .katex span.
  function mathAncestor(node) {
    return closestEl(node, '.katex-display') || closestEl(node, '.katex');
  }

  // Widen the range so it never cuts through an equation.
  function snapToMath(range) {
    var s = mathAncestor(range.startContainer);
    var e = mathAncestor(range.endContainer);
    if (s) range.setStartBefore(s);
    if (e) range.setEndAfter(e);
    return range;
  }

  function texOf(el) {
    var a = el.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent.trim() : el.textContent;
  }

  // The selection as Markdown-ish text with every equation back in TeX source.
  function quoteOf(range) {
    var frag = range.cloneContents();
    var host = document.createElement('div');
    host.className = 'cca-measure';
    host.appendChild(frag);
    host.querySelectorAll('.katex-display').forEach(function (el) {
      var d = document.createElement('div');
      d.textContent = '$$' + texOf(el) + '$$';
      el.replaceWith(d);
    });
    host.querySelectorAll('.katex').forEach(function (el) {
      el.replaceWith(document.createTextNode('$' + texOf(el) + '$'));
    });
    // innerText honors block layout (paragraph and list breaks), which
    // textContent drops, so the host must be rendered, just off-screen.
    document.body.appendChild(host);
    var text = host.innerText;
    host.remove();
    return text.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function annotatableRange() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    if (!closestEl(range.commonAncestorContainer, SCOPE)) return null;
    if (closestEl(range.startContainer, EXCLUDE) || closestEl(range.endContainer, EXCLUDE)) return null;
    if (!sel.toString().trim()) return null;
    return snapToMath(range.cloneRange());
  }

  function place() {
    if (!pop || !popRange) return;
    var rect = popRange.getBoundingClientRect();
    var rects = popRange.getClientRects();
    var first = rects.length ? rects[0] : rect;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    // The box sizes itself (auto-grow, drag handle), so read its size back.
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var left = Math.max(8, Math.min(first.left, vw - w - 8));
    var top = first.top - h - 6;
    if (top < 8) top = rect.bottom + 6;
    top = Math.max(8, Math.min(top, vh - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
    popRange = null;
    popEdit = null;
    paint();
  }

  // True when closing the pop-up would throw away typing.
  function dirty() {
    if (!pop) return false;
    return pop.querySelector('textarea').value.trim() !== (pop.dataset.initial || '').trim();
  }

  function composer() {
    return document.querySelector(COMPOSER);
  }

  function composerText() {
    var box = composer();
    return box ? box.textContent : '';
  }

  function caretToEnd(box) {
    var r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function fireInput(box, data) {
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: data }));
  }

  // Claude Code reads the prompt box with textContent, so newlines must be
  // literal "\n" characters in text nodes (the box is white-space: pre-wrap).
  // execCommand('insertText') would turn them into <div> blocks, which
  // textContent drops. This mirrors Claude Code's own insert helper: put a
  // text node in, move the caret after it, and fire the input event its
  // React onInput handler listens for.
  function insertIntoComposer(text) {
    var box = composer();
    if (!box) return false;
    box.focus();
    // Replace everything after the last non-blank character, so exactly one
    // blank line separates the note from what came before.
    var r = document.createRange();
    r.selectNodeContents(box);
    var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    var last = null, t;
    while ((t = walker.nextNode())) if (/\S/.test(t.data)) last = t;
    if (last) r.setStart(last, last.data.replace(/\s+$/, '').length);
    var data = (last ? '\n\n' : '') + text;
    r.deleteContents();
    var node = document.createTextNode(data);
    r.insertNode(node);
    caretToEnd(box);
    fireInput(box, data);
    return true;
  }

  // Edits and removals can touch several places at once (renumbering), so
  // they replace the whole text; Claude Code resets the box the same way.
  function setComposerText(text) {
    var box = composer();
    if (!box) return false;
    box.focus();
    box.textContent = text;
    caretToEnd(box);
    fireInput(box, text);
    return true;
  }

  function headerRe(n) {
    return new RegExp('^Annotation ' + n + ':[ \\t]*$', 'm');
  }

  // Block n runs from its header line to the line before the next blank line
  // (a note never contains one; see cleanNote).
  function findBlock(text, n) {
    var m = headerRe(n).exec(text);
    if (!m) return null;
    var gap = text.indexOf('\n\n', m.index);
    var end = gap < 0 ? Math.max(m.index, text.replace(/\s+$/, '').length) : gap;
    return { start: m.index, end: end, lines: text.slice(m.index, end).split('\n') };
  }

  function commentOf(n) {
    var b = findBlock(composerText(), n);
    if (!b) return '';
    var i = b.lines.findIndex(function (l) { return COMMENT_LINE.test(l); });
    return i < 0 ? '' : b.lines.slice(i + 1).join('\n');
  }

  function cleanNote(note) {
    return note.trim().replace(/\n[ \t]*\n[\s]*/g, '\n');
  }

  // Next number is one past the highest "Annotation N:" already in the
  // prompt box, so deleting or reordering notes before sending is harmless.
  function nextNumber() {
    var re = /^Annotation (\d+):/gm, m, max = 0, text = composerText();
    while ((m = re.exec(text))) max = Math.max(max, +m[1]);
    return max + 1;
  }

  function formatNote(n, quote, note) {
    var q = quote.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
    var head = 'Annotation ' + n + ':\n' + q + '\n';
    note = cleanNote(note);
    return note ? head + 'My comment:\n' + note + '\n' : head;
  }

  function editBlock(n, note) {
    var text = composerText();
    var b = findBlock(text, n);
    if (!b) return false;
    var i = b.lines.findIndex(function (l) { return COMMENT_LINE.test(l); });
    var head = (i < 0 ? b.lines : b.lines.slice(0, i)).join('\n');
    var block = note ? head + '\nMy comment:\n' + note : head;
    return setComposerText(text.slice(0, b.start) + block + text.slice(b.end));
  }

  function removeAnnotation(a) {
    var text = composerText();
    var b = findBlock(text, a.n);
    if (b) {
      var before = text.slice(0, b.start).replace(/\s+$/, '');
      var after = text.slice(b.end).replace(/^\s+/, '');
      var joined = before && after ? before + '\n\n' + after : before + after;
      // Close the gap in the numbering. Quote lines start with "> ", so only
      // real headers match.
      joined = joined.replace(/^Annotation (\d+):/gm, function (s, k) {
        return +k > a.n ? 'Annotation ' + (k - 1) + ':' : s;
      });
      setComposerText(joined);
    }
    annots = annots.filter(function (x) { return x !== a; });
    a.badge.remove();
    annots.forEach(function (x) { if (x.n > a.n) x.n--; });
  }

  function save() {
    if (!pop || !popRange) return;
    var note = cleanNote(pop.querySelector('textarea').value);
    var range = popRange;
    var a = popEdit;
    closePop();
    if (a) {
      // An emptied comment keeps the annotation as a bare quote; deleting
      // it is the trash button's job.
      if (!composer()) flash('Could not reach the prompt box.');
      else editBlock(a.n, note);
    } else {
      var n = nextNumber();
      var text = formatNote(n, quoteOf(range), note);
      if (insertIntoComposer(text)) {
        a = { n: n, range: range, badge: null };
        a.badge = makeBadge(a);
        annots.push(a);
      } else {
        // No prompt box: hand the text over through the clipboard so nothing
        // typed is lost.
        try { navigator.clipboard.writeText(text); } catch (e) {}
        flash('Could not reach the prompt box; the note was copied to the clipboard.');
      }
    }
    paint();
    placeBadges();
  }

  function flash(msg) {
    var t = document.createElement('div');
    t.className = 'cca-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  var CHECK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>';

  function button(cls, html, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = html;
    if (label) { b.title = label; b.setAttribute('aria-label', label); }
    // Keep focus where it is (the note, or the message selection).
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
    return b;
  }

  // Adding: a one-line box whose check button shows once there is text.
  // Editing (from a balloon): the comment, plus delete / Cancel / Save.
  function openPop(range, a) {
    closePop();
    popRange = range;
    popEdit = a || null;
    var initial = a ? commentOf(a.n) : '';
    pop = document.createElement('div');
    pop.className = a ? 'cca-pop cca-editing' : 'cca-pop';
    pop.dataset.initial = initial;
    var field = document.createElement('div');
    field.className = 'cca-field';
    var ta = document.createElement('textarea');
    ta.rows = 1;
    ta.placeholder = 'Add an optional comment\u2026';
    ta.value = initial;
    field.appendChild(ta);
    pop.appendChild(field);
    var ok = null;
    if (a) {
      var row = document.createElement('div');
      row.className = 'cca-actions';
      row.appendChild(button('cca-del', TRASH_SVG, 'Delete annotation', function () {
        closePop();
        removeAnnotation(a);
        paint();
        placeBadges();
      }));
      var spacer = document.createElement('span');
      spacer.className = 'cca-spacer';
      row.appendChild(spacer);
      row.appendChild(button('cca-cancel', 'Cancel', null, closePop));
      row.appendChild(button('cca-save', 'Save', null, save));
      pop.appendChild(row);
    } else {
      ok = document.createElement('div');
      ok.className = 'cca-okrow';
      ok.hidden = true;
      ok.appendChild(button('cca-ok', CHECK_SVG, 'Add (Enter)', save));
      pop.appendChild(ok);
    }
    document.body.appendChild(pop);
    ta.style.height = 'auto';
    var oneLine = ta.scrollHeight;
    // No button while empty. Short text: the check sits at the right end of
    // the line. Once the text needs a second line, the check moves to its own
    // row underneath so the text gets the full width.
    function layoutOk() {
      var has = !!ta.value.trim();
      ok.hidden = !has;
      pop.classList.remove('cca-stacked');
      pop.classList.toggle('cca-inline-ok', has);
      if (has) {
        ta.style.height = 'auto';
        if (ta.scrollHeight > oneLine + 1) {
          pop.classList.remove('cca-inline-ok');
          pop.classList.add('cca-stacked');
        }
      }
    }
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePop(); }
      e.stopPropagation();
    });
    // Grow with the text; Shift+Enter adds lines.
    ta.addEventListener('input', function () {
      if (ok) layoutOk();
      autosize(ta);
      place();
    });
    pop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    pop.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    if (initial) autosize(ta);
    place();
    paint();
    if (a) {
      // Opened from a balloon: there is no selection to keep, so type away.
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    // When adding, focus stays on the message selection so Ctrl+C still
    // copies it; the first typed character, or a paste (dictation tools
    // often paste), moves focus into the note (see onKeyDown).
  }

  // --- balloons ---------------------------------------------------------

  function makeBadge(a) {
    var b = document.createElement('div');
    b.className = 'cca-badge';
    b.textContent = String(a.n);
    // No focus change, no text selection starting on the balloon.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dirty()) return; // a note in progress wins
      openPop(a.range, a);
    });
    b.addEventListener('mouseenter', function () {
      var c = commentOf(a.n);
      b.title = c || '(no comment)';
    });
    document.body.appendChild(b);
    return b;
  }

  // Each balloon floats just above the end of its span, its pointed corner
  // on the span's last character so it never covers the next word, and hides
  // when the span scrolls out of the message list.
  function placeBadges() {
    if (!annots.length) return;
    var scope = document.querySelector(SCOPE);
    var clip = scope ? scope.getBoundingClientRect() : null;
    annots.forEach(function (a) {
      var b = a.badge;
      if (b.textContent !== String(a.n)) b.textContent = String(a.n);
      var rects = connected(a.range) ? a.range.getClientRects() : [];
      var last = null;
      for (var i = rects.length - 1; i >= 0; i--) {
        if (rects[i].width > 0) { last = rects[i]; break; }
      }
      var hidden = !last || (clip && (last.right < clip.left || last.right > clip.right ||
        last.bottom < clip.top || last.top > clip.bottom));
      b.style.display = hidden ? 'none' : '';
      if (hidden) return;
      b.style.left = last.right - 3 + 'px';
      b.style.top = last.top - 15 + 'px';
    });
  }

  function clearAll() {
    annots.forEach(function (a) { a.badge.remove(); });
    annots = [];
    paint();
  }

  // Both surfaces are plain text (the prompt box, and sent messages, which
  // Claude Code renders with plainText), so "bold" is a highlight painted over
  // the label lines. The prompt box shows its text through a mirror layer on
  // top of a transparent contentEditable; paint the mirror when it exists.
  function paintLabels() {
    if (!supportsHighlights()) return;
    var roots = [document.querySelector('[class*="mentionMirror_"]') || composer()];
    document.querySelectorAll('[class*="userMessage_"]').forEach(function (el) { roots.push(el); });
    var h = new Highlight();
    roots.forEach(function (root) {
      if (!root) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n, m;
      while ((n = walker.nextNode())) {
        LABEL_RE.lastIndex = 0;
        while ((m = LABEL_RE.exec(n.data))) {
          var r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          h.add(r);
        }
      }
    });
    CSS.highlights.set(HL_LABEL, h);
  }

  // Reconcile with the prompt box: sending empties it, which clears every
  // annotation; a header removed or renamed by hand drops its balloon.
  function sync() {
    if (annots.length) {
      var text = composerText();
      if (!text.trim()) {
        clearAll();
      } else {
        var before = annots.length;
        annots = annots.filter(function (a) {
          var keep = headerRe(a.n).test(text);
          if (!keep) a.badge.remove();
          return keep;
        });
        if (annots.length !== before) paint();
      }
    }
    placeBadges();
    paintLabels();
    place();
  }

  var queued = false;
  function queueSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; sync(); });
  }

  function onMouseUp(e) {
    if (e.button !== 0) return;
    // Let the browser finish updating the selection first.
    setTimeout(function () {
      var range = annotatableRange();
      if (!range) return;
      if (dirty()) return; // keep a note in progress
      openPop(range);
    }, 0);
  }

  function onMouseDown(e) {
    if (!pop || pop.contains(e.target)) return;
    if (dirty()) return;
    closePop();
  }

  // Capture phase, so this runs before any handler in Claude Code's UI that
  // would redirect typing to the prompt box.
  function onKeyDown(e) {
    if (!pop) return;
    var ta = pop.querySelector('textarea');
    if (document.activeElement === ta) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); return; }
    var paste = ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V')) ||
      (e.shiftKey && e.key === 'Insert');
    if (paste) {
      e.stopPropagation();
      ta.focus(); // the paste now lands in the note
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+C etc. act on the selection
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter before typing anything: add the quote with no note.
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key.length === 1) {
      e.stopPropagation();
      ta.focus(); // the key's default action now lands in the note
    }
  }

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', queueSync, true);
  window.addEventListener('scroll', queueSync, true);
  window.addEventListener('resize', queueSync);
  // Streaming replies, sending (which empties the prompt box), and edits
  // typed straight into the prompt box all show up as DOM mutations.
  new MutationObserver(queueSync).observe(document.documentElement,
    { childList: true, subtree: true, characterData: true });

  window.__CCA = { quoteOf: quoteOf, formatNote: formatNote, insertIntoComposer: insertIntoComposer };
})();
