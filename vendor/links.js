/* File links in Claude's replies: hover shows the full path, right-click
 * opens a menu (Open, Open with system app, Reveal in sidebar, Open
 * containing folder, Copy full path, Copy link) in place of Claude Code's
 * "Copy Link".
 *
 * The webview can only message Claude Code's own extension, so menu actions
 * that need VS Code are real <a href="vscode://..."> links handled by this
 * extension's URI handler. VS Code forwards a link click from a webview only
 * when it is a genuine user click, and the menu lives outside Claude Code's
 * React tree, so nothing stops that click on its way.
 *
 * Left-clicking a folder link would make Claude Code try to open the folder
 * as a text document, which fails without a trace. So while the mouse is on
 * a link that looks like a folder (no file extension), a transparent
 * <a href="vscode://...action=open"> sits over it and takes the click; the
 * handler opens a folder in the file manager and a file in the editor, so an
 * extensionless file (Makefile) still opens normally. */
(function () {
  if (window.__CCL_LOADED) return;
  window.__CCL_LOADED = true;

  var SCOPE = '[class*="messagesContainer_"]';
  // Filled in with this extension's ID when the patch is applied.
  var HANDLER = '__CCL_HANDLER__';
  var menu = null;
  var overlay = null;  // the click-taker over a folder-like link

  // The file a link points at, or null for web links and anchors. Mirrors
  // Claude Code's own parsing: "path", "path:12", "path:12-20", "path#L12".
  function fileTarget(a) {
    var href = a.getAttribute('href') || '';
    if (/^(https?|mailto|vscode|command):/i.test(href) || href.charAt(0) === '#' || !href) return null;
    if (/^file:\/\//i.test(href)) href = href.replace(/^file:\/\//i, '');
    var line = null;
    var m = /^(.*?)(?:[:#]L?(\d+)(?:-L?\d+)?)$/.exec(href);
    if (m && m[1]) { href = m[1]; line = +m[2]; }
    var p;
    try { p = decodeURIComponent(href); } catch (e) { return null; }
    if (/[\x00-\x1f]/.test(p)) return null;
    return { path: p, line: line, href: a.getAttribute('href') };
  }

  function linkAt(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var a = el && el.closest('a[href]');
    return a && a.closest(SCOPE) ? a : null;
  }

  function actionUrl(action, t) {
    var q = 'action=' + action + '&path=' + encodeURIComponent(t.path);
    if (t.line) q += '&line=' + t.line;
    return HANDLER + '?' + q;
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); } catch (e) {}
  }

  // Last path segment has no extension, or the path ends with a slash.
  function looksLikeFolder(t) {
    var p = t.path.replace(/\/+$/, '');
    if (t.path !== p) return true;
    var last = p.slice(p.lastIndexOf('/') + 1);
    return !!last && last.indexOf('.') <= 0 && !t.line;
  }

  function dropOverlay() {
    if (overlay) overlay.remove();
    overlay = null;
  }

  // Cover the line box of the link under the mouse (a link can wrap).
  function placeOverlay(a, t, x, y) {
    var rects = a.getClientRects(), r = null;
    for (var i = 0; i < rects.length; i++) {
      var c = rects[i];
      if (x >= c.left && x <= c.right && y >= c.top && y <= c.bottom) { r = c; break; }
    }
    if (!r) return;
    if (!overlay) {
      overlay = document.createElement('a');
      overlay.className = 'ccl-overlay';
      overlay.addEventListener('mouseleave', dropOverlay);
      overlay.addEventListener('click', function () { setTimeout(dropOverlay, 0); });
      document.body.appendChild(overlay);
    }
    overlay.href = actionUrl('open', t);
    overlay.title = t.path;
    overlay.__cclTarget = t;
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  function item(label, opts) {
    var a = document.createElement('a');
    a.className = 'ccl-item';
    a.textContent = label;
    if (opts.url) {
      a.href = opts.url;
      // Let the click travel on to VS Code's link forwarder; only tidy up.
      a.addEventListener('click', function () { setTimeout(closeMenu, 0); });
    } else {
      a.href = '#';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        opts.run();
        closeMenu();
      });
    }
    return a;
  }

  function openMenu(t, x, y) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'ccl-menu';
    menu.setAttribute('role', 'menu');
    menu.appendChild(item('Open', { url: actionUrl('open', t) }));
    menu.appendChild(item('Open with system app', { url: actionUrl('system', t) }));
    menu.appendChild(item('Reveal in sidebar', { url: actionUrl('reveal', t) }));
    menu.appendChild(item('Open containing folder', { url: actionUrl('folder', t) }));
    var sep = document.createElement('div');
    sep.className = 'ccl-sep';
    menu.appendChild(sep);
    menu.appendChild(item('Copy full path', { run: function () { copy(t.path); } }));
    menu.appendChild(item('Copy link', { run: function () { copy(t.href); } }));
    document.body.appendChild(menu);
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    menu.style.left = Math.max(4, Math.min(x, vw - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, vh - menu.offsetHeight - 4)) + 'px';
  }

  // Capture phase on window: runs before Claude Code's React handler, which
  // would open its own "Copy Link" menu.
  window.addEventListener('contextmenu', function (e) {
    var a = linkAt(e.target);
    var t = e.target === overlay ? overlay.__cclTarget : a && fileTarget(a);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(t, e.clientX, e.clientY);
  }, true);

  document.addEventListener('mouseover', function (e) {
    var a = linkAt(e.target);
    if (!a || a.dataset.cclTitled) return;
    var t = fileTarget(a);
    if (!t) return;
    a.title = t.line ? t.path + ':' + t.line : t.path;
    a.dataset.cclTitled = '1';
  });

  document.addEventListener('mousemove', function (e) {
    if (e.target === overlay) return;
    var a = linkAt(e.target);
    var t = a && fileTarget(a);
    if (t && looksLikeFolder(t)) placeOverlay(a, t, e.clientX, e.clientY);
    else dropOverlay();
  });

  window.addEventListener('mousedown', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('keydown', function (e) {
    if (menu && e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('scroll', function () { closeMenu(); dropOverlay(); }, true);
  window.addEventListener('resize', closeMenu);

  window.__CCL = { fileTarget: fileTarget, actionUrl: actionUrl, looksLikeFolder: looksLikeFolder };
})();
