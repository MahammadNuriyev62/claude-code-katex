// End-to-end check of vendor/annotate.js in headless Chromium, with trusted
// mouse and keyboard input. Run: node test/annotate-harness.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.join(here, 'harness', 'annotate.html');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     ' + detail));
  if (!ok) failures++;
}

// Viewport point at character `offset` of the first text node under `sel`
// (or the element's box center / edges when `where` says so).
async function point(page, sel, where) {
  return page.evaluate(([sel, where]) => {
    const el = document.querySelector(sel);
    if (where.char !== undefined) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      const r = document.createRange();
      r.setStart(t, where.char); r.setEnd(t, where.char + 1);
      const b = r.getBoundingClientRect();
      return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    const b = el.getBoundingClientRect();
    if (where.edge === 'mid') return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    return { x: b.right - 2, y: b.top + b.height / 2 };
  }, [sel, where]);
}

async function drag(page, a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
}

const composerText = (page) => page.$eval('[aria-label="Message input"]', (el) => el.textContent); // what Claude Code reads

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 900, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failures++; });
await page.goto(url);

// 1. Selection from plain text into the middle of an inline equation.
{
  const a = await point(page, '#p1', { char: 4 });                 // "density"
  const b = await point(page, '#p1 .katex:first-of-type .katex-html', { edge: 'mid' });
  await drag(page, a, b);
  check('pop-up opens on selection', await page.$('.cca-pop') !== null, 'no .cca-pop');
  const box = await page.$eval('.cca-pop textarea', (t) => ({
    w: t.offsetWidth, rows: t.rows, placeholder: t.placeholder,
    radius: getComputedStyle(t.closest('.cca-pop')).borderRadius,
    visibleButtons: [...document.querySelectorAll('.cca-pop button')].filter((b) => b.offsetParent).length,
  }));
  check('one-line 240px box in a rounded card, no buttons before typing',
    box.w === 240 && box.rows === 1 && box.radius === '12px' && box.visibleButtons === 0 &&
    box.placeholder === 'Add an optional comment\u2026', JSON.stringify(box));
  const ctrlC = await page.evaluate(() => window.getSelection().toString().length > 0);
  check('message selection survives while pop-up is open (Ctrl+C still works)', ctrlC, 'selection collapsed');
  await page.keyboard.type('why this normalizer?');               // first key moves focus into the note
  const note = await page.$eval('.cca-pop textarea', (t) => t.value);
  check('typing goes into the note', note === 'why this normalizer?', JSON.stringify(note));
  const ok = await page.$eval('.cca-ok', (b) => ({ shown: !!b.offsetParent, bg: getComputedStyle(b).backgroundColor,
    fg: getComputedStyle(b).color, svg: !!b.querySelector('svg path') }));
  const inline = await page.evaluate(() => {
    const pop = document.querySelector('.cca-pop'), ta = pop.querySelector('textarea'), b = pop.querySelector('.cca-ok');
    const tr = ta.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { stacked: pop.classList.contains('cca-stacked'), onLine: br.top >= tr.top && br.bottom <= tr.bottom, pad: getComputedStyle(ta).paddingRight };
  });
  check('short text: check sits at the right end of the line',
    !inline.stacked && inline.onLine && inline.pad === '42px', JSON.stringify(inline));
  check('check button appears once there is text: black, thin white check',
    ok.shown && ok.bg === 'rgb(0, 0, 0)' && ok.fg === 'rgb(255, 255, 255)' && ok.svg, JSON.stringify(ok));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  const grown = await page.$eval('.cca-pop textarea', (t) => t.offsetHeight > t.scrollHeight - 4 && t.value.includes('\n'));
  check('Shift+Enter adds a line and the box grows to fit', grown, 'did not grow');
  const stacked = await page.evaluate(() => {
    const pop = document.querySelector('.cca-pop'), ta = pop.querySelector('textarea'), b = pop.querySelector('.cca-ok');
    return { stacked: pop.classList.contains('cca-stacked'), below: b.getBoundingClientRect().top >= ta.getBoundingClientRect().bottom,
      pad: getComputedStyle(ta).paddingRight };
  });
  check('multi-line text moves the check to its own row, text gets full width',
    stacked.stacked && stacked.below && stacked.pad === '8px', JSON.stringify(stacked));
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  const want = 'Annotation 1:\n> density is $p(x \\mid \\mu, \\sigma^2) = \\frac{1}{\\sqrt{2\\pi\\sigma^2}}$\nMy comment:\nwhy this normalizer?\nsecond line';
  check('quote snaps to whole equation, TeX restored, note appended', text.trim() === want, JSON.stringify(text));
  const events = await page.evaluate(() => window.inputEvents);
  check('prompt box got a real input event (React onInput fires)',
    events.length > 0 && events[events.length - 1].type === 'insertText', JSON.stringify(events));
  check('pop-up closed after adding', await page.$('.cca-pop') === null, 'still open');
}

// 2. Multi-paragraph selection across a display equation; appended as a
//    second block with a blank line between.
{
  const a = await point(page, '#p2', { char: 2 });
  const b = await point(page, '#p3', { char: 7 });
  await drag(page, a, b);
  await page.click('.cca-pop textarea');
  await page.keyboard.type('check this identity');
  await page.click('.cca-ok');
  check('the check button adds the note', await page.$('.cca-pop') === null, 'still open');
  const text = await composerText(page);
  const second = text.slice(text.indexOf('Annotation 2:')).trim();
  check('exactly one blank line between annotations', /normalizer\?\nsecond line\n\nAnnotation 2:/.test(text), JSON.stringify(text));
  const want = [
    'Annotation 2:',
    '> second paragraph before the display.',
    '>',
    '> $$\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$$',
    '>',
    '> Closing',
    'My comment:',
    'check this identity',
  ].join('\n');
  check('display math and paragraph breaks preserved in second note', second === want,
    JSON.stringify(second) + '\n     want ' + JSON.stringify(want));
}

// 2b. Enter with nothing typed adds the quote alone; numbering continues
//     from the highest number present even after the user deletes one.
{
  await page.$eval('[aria-label="Message input"]', (el) => {
    el.textContent = el.textContent.replace(/^Annotation 1:[\s\S]*?(?=Annotation 2:)/, '');
  });
  const a = await point(page, '#p3', { char: 14 });
  const b = await point(page, '#p3', { char: 19 });
  await drag(page, a, b);
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  check('Enter before typing adds quote only, numbered 3 after deleting 1',
    /identity\n\nAnnotation 3:\n> after\s*$/.test(text) && !/Annotation 1:/.test(text), JSON.stringify(text));
}

// 2c. Label lines are painted bold in the prompt box and in sent messages.
{
  await page.waitForTimeout(50);
  const labels = await page.evaluate(() => {
    const h = CSS.highlights.get('cca-label');
    return h ? [...h].map((r) => r.toString() + '@' + (r.startContainer.parentElement.closest('[id]')?.id || r.startContainer.parentElement.getAttribute('aria-label'))) : [];
  });
  const want = ['Annotation 7:@sent', 'My comment:@sent', 'Annotation 2:@Message input', 'My comment:@Message input', 'Annotation 3:@Message input'];
  check('labels highlighted in prompt box and sent message', JSON.stringify(labels.sort()) === JSON.stringify(want.sort()), JSON.stringify(labels));
  const quoteNotLabel = labels.every((l) => !l.startsWith('>'));
  check('quote lines are not painted as labels', quoteNotLabel, JSON.stringify(labels));
}

// 3. Selecting in the user's own message or the prompt box does nothing.
{
  const a = await point(page, '#user', { char: 0 });
  const b = await point(page, '#user', { char: 10 });
  await drag(page, a, b);
  check('no pop-up on the user\'s own message', await page.$('.cca-pop') === null, 'pop-up opened');
}

// 4. Esc cancels without touching the prompt box. On the way: the check
//    button hides again when the text is erased, turns white in dark themes,
//    and a paste (how many dictation tools deliver text) lands in the note.
{
  const before = await composerText(page);
  const a = await point(page, '#p3', { char: 0 });
  const b = await point(page, '#p3', { char: 12 });
  await drag(page, a, b);
  await page.evaluate(() => navigator.clipboard.writeText('pasted by dictation'));
  await page.keyboard.press('Control+V');
  const pasted = await page.$eval('.cca-pop textarea', (t) => ({ v: t.value, focused: document.activeElement === t }));
  check('Ctrl+V pastes into the note', pasted.v === 'pasted by dictation' && pasted.focused, JSON.stringify(pasted));
  const dark = await page.evaluate(() => {
    document.body.classList.add('vscode-dark');
    const b = document.querySelector('.cca-ok');
    const r = { bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(b).color };
    document.body.classList.remove('vscode-dark');
    return r;
  });
  check('check button is white with a dark check in dark themes',
    dark.bg === 'rgb(255, 255, 255)' && dark.fg === 'rgb(0, 0, 0)', JSON.stringify(dark));
  await page.keyboard.type(' and then a longer sentence that has to wrap');
  check('typing past the end of the line moves the check to its own row',
    await page.$eval('.cca-pop', (p) => p.classList.contains('cca-stacked')), 'not stacked');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  check('check button hides when the text is erased',
    await page.$eval('.cca-ok', (b) => !b.offsetParent && !b.closest('.cca-pop').classList.contains('cca-stacked')), 'still shown');
  await page.keyboard.press('Escape');
  check('Esc closes the pop-up', await page.$('.cca-pop') === null, 'still open');
  check('Esc leaves the prompt box unchanged', (await composerText(page)) === before, 'changed');
}

// 6. Balloons: one per annotation in the prompt box, blue, just past the
//    end of the span, showing the comment on hover.
const balloon = (n) => page.locator('.cca-badge', { hasText: new RegExp('^' + n + '$') });
{
  await page.waitForTimeout(50);
  const badges = await page.$$eval('.cca-badge', (bs) => bs.map((b) => ({ t: b.textContent, bg: getComputedStyle(b).backgroundColor, shown: b.style.display !== 'none' })));
  check('one balloon per annotation; the hand-deleted #1 lost its balloon',
    JSON.stringify(badges.map((b) => b.t)) === '["2","3"]' && badges.every((b) => b.shown), JSON.stringify(badges));
  check('balloons are blue', badges.every((b) => b.bg === 'rgb(47, 129, 247)'), JSON.stringify(badges));
  const pos = await page.evaluate(() => {
    const t = document.querySelector('#p3').firstChild;
    const r = document.createRange(); r.setStart(t, 14); r.setEnd(t, 19);
    const e = r.getBoundingClientRect();
    const b = [...document.querySelectorAll('.cca-badge')].find((x) => x.textContent === '3').getBoundingClientRect();
    return { dx: b.left - e.right, dy: b.top - e.top };
  });
  check('balloon floats just above the end of its span', pos.dx >= -4 && pos.dx <= 0 && pos.dy <= -12 && pos.dy >= -18, JSON.stringify(pos));
  // file:// stylesheets are unreadable from the page, so check the rule here.
  const css = fs.readFileSync(path.join(here, '..', 'vendor', 'annotate.css'), 'utf8');
  const notedBg = (/::highlight\(cca-noted\)\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  check('noted text keeps the blue selection background', notedBg.includes('--vscode-editor-selectionBackground'), notedBg);
  await balloon(2).hover();
  check('hovering a balloon shows its comment', (await balloon(2).getAttribute('title')) === 'check this identity',
    await balloon(2).getAttribute('title'));
}

// 7. Click a balloon to edit its comment in place.
{
  await balloon(2).click();
  const st = await page.evaluate(() => {
    const ta = document.querySelector('.cca-pop textarea');
    return { v: ta && ta.value, focused: document.activeElement === ta };
  });
  check('balloon opens its comment, focused and ready to edit', st.v === 'check this identity' && st.focused, JSON.stringify(st));
  const card = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.cca-pop button')].map((b) => b.getAttribute('aria-label') || b.textContent),
    save: getComputedStyle(document.querySelector('.cca-save')).backgroundColor,
    trashIcon: !!document.querySelector('.cca-del svg'),
  }));
  check('edit card has delete, Cancel and a black Save',
    JSON.stringify(card.buttons) === '["Delete annotation","Cancel","Save"]' && card.save === 'rgb(0, 0, 0)' && card.trashIcon,
    JSON.stringify(card));
  await page.keyboard.press('Control+A');
  await page.keyboard.type('revised comment');
  await page.keyboard.press('Enter');
  const text = await composerText(page);
  check('edit rewrites only that block',
    text.startsWith('Annotation 2:\n> second paragraph') && /My comment:\nrevised comment\n\nAnnotation 3:\n> after\s*$/.test(text) &&
    !text.includes('check this identity'), JSON.stringify(text));
}

// 7b. A quote-only annotation gets a comment through its balloon.
{
  await balloon(3).click();
  await page.keyboard.type('now with a comment');
  await page.click('.cca-save');
  const text = await composerText(page);
  check('comment added to a quote-only note (Save button)', /revised comment\n\nAnnotation 3:\n> after\nMy comment:\nnow with a comment\s*$/.test(text), JSON.stringify(text));
}

// 7c. The prompt box is the source of truth: a comment edited there by hand
//     is what the balloon shows. 7d. Unsaved edits survive a stray click;
//     Esc discards them.
{
  await page.$eval('[aria-label="Message input"]', (el) => {
    el.textContent = el.textContent.replace('revised comment', 'typed in the box');
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  await balloon(2).click();
  const v = await page.$eval('.cca-pop textarea', (t) => t.value);
  check('balloon reads the prompt box, so hand edits show up', v === 'typed in the box', JSON.stringify(v));
  await page.keyboard.type(' more');
  await page.mouse.click(5, 5);
  check('clicking away keeps a changed note open', await page.$('.cca-pop') !== null, 'closed');
  await page.keyboard.press('Escape');
  const text = await composerText(page);
  check('Esc discards the edit', await page.$('.cca-pop') === null && text.includes('typed in the box\n\n') && !text.includes(' more'),
    JSON.stringify(text));
  await balloon(2).click();
  await page.keyboard.type(' and more');
  await page.click('.cca-cancel');
  const after = await composerText(page);
  check('Cancel discards the edit', await page.$('.cca-pop') === null && after === text, JSON.stringify(after));
}

// 8. Emptying a comment keeps the annotation as a bare quote; the trash
//    button deletes the whole annotation and renumbers the rest.
{
  await balloon(2).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  let text = await composerText(page);
  check('empty + Enter keeps the quote, drops the comment',
    /> Closing\n\nAnnotation 3:/.test(text) && !text.includes('typed in the box') &&
    (await page.$$eval('.cca-badge', (bs) => bs.length)) === 2, JSON.stringify(text));

  await balloon(2).click();
  await page.click('.cca-del');
  await page.waitForTimeout(50);
  text = await composerText(page);
  check('delete removes the whole block and renumbers the next one',
    await page.$('.cca-pop') === null && text.trimEnd() === 'Annotation 2:\n> after\nMy comment:\nnow with a comment',
    JSON.stringify(text));
  const badges = await page.$$eval('.cca-badge', (bs) => bs.map((b) => b.textContent));
  check('its balloon goes and the next balloon is renumbered', JSON.stringify(badges) === '["2"]', JSON.stringify(badges));
}

// 9. Balloons hide when their span scrolls out of the message list.
{
  await page.$eval('[class^="messagesContainer_"]', (el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(80);
  const hidden = await page.$eval('.cca-badge', (b) => b.style.display === 'none');
  await page.$eval('[class^="messagesContainer_"]', (el) => { el.scrollTop = 0; });
  await page.waitForTimeout(80);
  const shown = await page.$eval('.cca-badge', (b) => b.style.display !== 'none');
  check('balloon hides when scrolled out of view and comes back', hidden && shown, JSON.stringify({ hidden, shown }));
}

// 10. Sending (Claude Code empties the prompt box) clears highlights and
//     balloons.
{
  const n = await page.evaluate(() => CSS.highlights.get('cca-noted')?.size ?? 0);
  check('noted spans highlighted', n === 1, 'size ' + n);
  await page.$eval('[aria-label="Message input"]', (el) => { el.textContent = ''; });
  await page.waitForTimeout(50);
  const m = await page.evaluate(() => CSS.highlights.get('cca-noted')?.size ?? 0);
  const b = await page.$$eval('.cca-badge', (bs) => bs.length);
  check('highlights and balloons cleared after send', m === 0 && b === 0, JSON.stringify({ m, b }));
}

// 11. Claude Code turns text selection off for its whole app and back on
//     per message type; Focus view draws replies outside that list. The
//     message list must stay selectable anyway. Control: with the rule
//     overridden, the same drag selects nothing.
{
  const dragSelect = async () => {
    const a = await point(page, '#p3', { char: 0 });
    const b = await point(page, '#p3', { char: 7 });
    await drag(page, a, b);
    const text = await page.evaluate(() => window.getSelection().toString());
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    return text;
  };
  await page.evaluate(() => { document.body.style.userSelect = 'none'; document.body.style.webkitUserSelect = 'none'; });
  const withRule = await dragSelect();
  await page.addStyleTag({ content: '[class*="messagesContainer_"] { user-select: auto !important; -webkit-user-select: auto !important; }' });
  const withoutRule = await dragSelect();
  check('replies stay selectable when the app turns selection off (Focus view)',
    withRule.startsWith('Closing') && withoutRule === '', JSON.stringify({ withRule, withoutRule }));
}

await page.screenshot({ path: path.join(here, '..', 'test-results', 'annotate.png') }).catch(() => {});
await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
