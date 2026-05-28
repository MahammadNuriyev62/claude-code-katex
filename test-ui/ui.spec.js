// @ts-check
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9876;

// Extract the observer script from extension.js at runtime,
// so the UI test always matches the actual shipped code.
// We mock the vscode module before requiring extension.js.
function getObserverScript() {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...args);
  };
  require.cache['vscode'] = {
    id: 'vscode', filename: 'vscode', loaded: true,
    exports: {
      window: { showInformationMessage: () => Promise.resolve(), showErrorMessage: () => {} },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
      extensions: { getExtension: () => null, onDidChange: () => ({ dispose() {} }) },
    },
  };
  const { _test } = require(path.join(ROOT, 'extension'));
  Module._resolveFilename = origResolve;
  return _test.getMutationObserverScript();
}

// Minimal static file server that serves vendor/ and test-ui/ files,
// and injects the real patch script into harness.html.
function createServer() {
  const patchScript = getObserverScript();

  return http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url);
    if (req.url === '/') filePath = path.join(__dirname, 'harness.html');

    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    };

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      let content = data;
      // Inject the real patch script into the harness.
      // Use a function replacement to avoid $ being treated as a special pattern.
      if (req.url === '/') {
        content = data.toString().replace(
          '/* __PATCH_SCRIPT__ */',
          () => patchScript
        );
      }

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    });
  });
}

let server;

test.beforeAll(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Helper: wait for KaTeX debounce (200ms) + margin
const RENDER_WAIT = 400;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('KaTeX patch - initial rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('renders KaTeX elements in the messages container', async ({ page }) => {
    const count = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(count).toBeGreaterThanOrEqual(6);
  });

  test('renders display math blocks', async ({ page }) => {
    const count = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('does NOT render KaTeX inside the input area', async ({ page }) => {
    const count = await page.locator('[class*="inputContainer"] .katex').count();
    expect(count).toBe(0);
  });

  test('input is still contenteditable', async ({ page }) => {
    const editable = await page.locator('#chat-input').getAttribute('contenteditable');
    expect(editable).toBe('true');
  });

  test('no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.reload();
    await page.waitForTimeout(RENDER_WAIT);
    expect(errors).toEqual([]);
  });
});

test.describe('KaTeX patch - input isolation (the bug fix)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('typing $ characters in input does not garble text', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('price is $100 and $200', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const text = await input.textContent();
    expect(text).toBe('price is $100 and $200');
  });

  test('typing \\ characters in input does not garble text', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('path\\to\\file and \\n', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const text = await input.textContent();
    expect(text).toBe('path\\to\\file and \\n');
  });

  test('typing mixed $ and \\ does not create KaTeX in input', async ({ page }) => {
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$x^2$ and \\frac{1}{2}', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const katexInInput = await page.locator('[class*="inputContainer"] .katex').count();
    expect(katexInInput).toBe(0);

    const text = await input.textContent();
    expect(text).toBe('$x^2$ and \\frac{1}{2}');
  });

  test('typing in input does not trigger removeChild crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const input = page.locator('#chat-input');
    await input.click();
    // Rapid typing with lots of $ and \ to stress-test
    await input.pressSequentially('$$$\\\\$test$\\frac$\\$end', { delay: 10 });
    await page.waitForTimeout(RENDER_WAIT);

    expect(errors).toEqual([]);
  });

  test('messages math is unaffected after typing in input', async ({ page }) => {
    const beforeCount = await page.locator('[class*="messagesContainer"] .katex').count();

    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$hello$ \\world', { delay: 20 });
    await page.waitForTimeout(RENDER_WAIT);

    const afterCount = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(afterCount).toBe(beforeCount);
  });
});

test.describe('KaTeX patch - dynamic messages (streaming)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  test('new message with math is auto-rendered', async ({ page }) => {
    const before = await page.locator('[class*="messagesContainer"] .katex').count();

    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      const msg = document.createElement('div');
      msg.className = 'message_07S1Yg assistant';
      msg.innerHTML = `
        <div class="message-label">Claude</div>
        <div class="message-bubble">New: $E = mc^2$</div>
      `;
      container.appendChild(msg);
    });

    await page.waitForTimeout(RENDER_WAIT);
    const after = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(after).toBeGreaterThan(before);
  });

  test('new display math is auto-rendered', async ({ page }) => {
    const before = await page.locator('[class*="messagesContainer"] .katex-display').count();

    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      const msg = document.createElement('div');
      msg.className = 'message_07S1Yg assistant';
      msg.innerHTML = `
        <div class="message-label">Claude</div>
        <div class="message-bubble">$$\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$$</div>
      `;
      container.appendChild(msg);
    });

    await page.waitForTimeout(RENDER_WAIT);
    const after = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(after).toBeGreaterThan(before);
  });
});

test.describe('KaTeX patch - chat navigation (container replacement)', () => {
  test('re-attaches observer when messages container is replaced', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    // Replace the entire messages container (simulates React re-mount on chat switch)
    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      next.className = 'messagesContainer_07S1Yg';
      next.innerHTML = `
        <div class="message_07S1Yg assistant">
          <div class="message-label">Claude</div>
          <div class="message-bubble">New chat: $a^2 + b^2 = c^2$ and $$e^x = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}$$</div>
        </div>
      `;
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const katex = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(katex).toBeGreaterThanOrEqual(2);

    const display = await page.locator('[class*="messagesContainer"] .katex-display').count();
    expect(display).toBeGreaterThanOrEqual(1);
  });

  test('input stays clean after chat navigation', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    // Type in input first
    const input = page.locator('#chat-input');
    await input.click();
    await input.pressSequentially('$keepme$', { delay: 20 });

    // Replace messages container
    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      next.className = 'messagesContainer_07S1Yg';
      next.innerHTML = '<div class="message_07S1Yg assistant"><div class="message-bubble">$x$</div></div>';
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const inputKatex = await page.locator('[class*="inputContainer"] .katex').count();
    expect(inputKatex).toBe(0);

    const text = await input.textContent();
    expect(text).toBe('$keepme$');
  });
});

test.describe('KaTeX patch - selector robustness', () => {
  test('works with different CSS module hashes', async ({ page }) => {
    // Load the page then swap the class to a different hash (simulating a
    // different Claude Code version). The rootObserver should still find it.
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    await page.evaluate(() => {
      const chat = document.querySelector('[class*="chatContainer"]');
      const old = document.querySelector('[class*="messagesContainer"]');
      const next = document.createElement('div');
      // Different hash suffix than the original _07S1Yg
      next.className = 'messagesContainer_xY9zKw';
      next.innerHTML = '<div class="message_07S1Yg assistant"><div class="message-bubble">$\\pi \\approx 3.14$</div></div>';
      chat.replaceChild(next, old);
    });

    await page.waitForTimeout(RENDER_WAIT);

    const katex = await page.locator('[class*="messagesContainer"] .katex').count();
    expect(katex).toBeGreaterThanOrEqual(1);
  });

  test('gracefully handles missing messages container', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Remove the messages container entirely
    await page.evaluate(() => {
      const container = document.querySelector('[class*="messagesContainer"]');
      container.remove();
    });

    await page.waitForTimeout(RENDER_WAIT);
    expect(errors).toEqual([]);
  });
});

// Helper: inject a message and return its bubble element's text + katex count
async function injectAndCheck(page, html, WAIT) {
  const id = 'test-msg-' + Date.now();
  await page.evaluate(({ html, id }) => {
    const container = document.querySelector('[class*="messagesContainer"]');
    const msg = document.createElement('div');
    msg.className = 'message_07S1Yg assistant';
    msg.innerHTML = '<div class="message-label">Claude</div><div class="message-bubble" id="' + id + '">' + html + '</div>';
    container.appendChild(msg);
  }, { html, id });
  await page.waitForTimeout(WAIT);
  const bubble = page.locator('#' + id);
  return {
    text: await bubble.textContent(),
    katex: await bubble.locator('.katex').count(),
    katexDisplay: await bubble.locator('.katex-display').count(),
  };
}

test.describe('Currency $ vs math $ disambiguation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(RENDER_WAIT);
  });

  // --- Currency: must NOT render as math ---

  test('$100 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The price is $100.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$100');
  });

  test('$2.50 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'It costs $2.50 per unit.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$2.50');
  });

  test('$1,000 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The budget is $1,000 this quarter.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$1,000');
  });

  test('$5M is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Revenue hit $5M last year.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$5M');
  });

  test('multiple currency amounts do not pair up', async ({ page }) => {
    const r = await injectAndCheck(page, 'Budget: $50 for food, $30 for transport, $20 for tickets.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$50');
    expect(r.text).toContain('$30');
    expect(r.text).toContain('$20');
  });

  test('$100 and $200 in same sentence do not pair', async ({ page }) => {
    const r = await injectAndCheck(page, '$100 is less than $200.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$100');
    expect(r.text).toContain('$200');
  });

  // --- Math: must render ---

  test('$x^2$ renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The value of $x^2$ is positive.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$E = mc^2$ renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Einstein showed that $E = mc^2$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\frac{1}{2}$ renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The fraction $\\frac{1}{2}$ is one half.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('single letter $x$ renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Let $x$ be a variable.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$-5$ (negative number) renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The result is $-5$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  // --- Digit-leading math WITH a valid closing $ must render. Pandoc only
  //     blocks currency on the closing side, so $10^{-4}$ is legal math. ---

  test('$10^{-4}$ renders (digit-leading content)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Around $10^{-4}$ in magnitude.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$10^{-4}\\text{–}10^{-5}$ renders as one span', async ({ page }) => {
    const r = await injectAndCheck(page, 'The range $10^{-4}\\text{–}10^{-5}$ here.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$2x$ renders (digit-leading but valid math)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Compute $2x$ now.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('currency and digit-math coexist on one line', async ({ page }) => {
    const r = await injectAndCheck(page, 'About $5 and then $10^{-4}$ each.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1); // the math span renders
    expect(r.text).toContain('$5');            // the currency stays literal
  });

  test('$$...$ (display math) still works', async ({ page }) => {
    const r = await injectAndCheck(page, '$$\\int_0^1 f(x) dx$$', RENDER_WAIT);
    expect(r.katexDisplay).toBeGreaterThanOrEqual(1);
  });

  test('\\(...\\) renders as inline math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Also \\(a + b\\) works.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('\\[...\\] renders as display math', async ({ page }) => {
    const r = await injectAndCheck(page, '\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]', RENDER_WAIT);
    expect(r.katexDisplay).toBeGreaterThanOrEqual(1);
  });

  // --- More currency formats ---

  test('$0.99 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'On sale for $0.99 each.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$0.99');
  });

  test('$50.00 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The total comes to $50.00.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$50.00');
  });

  test('$1,234.56 is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Grand total: $1,234.56 after tax.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$1,234.56');
  });

  test('$3.5B is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'The company raised $3.5B in funding.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$3.5B');
  });

  test('$50k is not rendered as math', async ({ page }) => {
    const r = await injectAndCheck(page, 'Salaries start at $50k.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$50k');
  });

  test('price range $50-$100 does not pair', async ({ page }) => {
    const r = await injectAndCheck(page, 'Expect to pay $50-$100 for this.', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$50');
    expect(r.text).toContain('$100');
  });

  // --- More math edge cases ---

  test('$(a+b)^2$ renders (starts with paren)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Expand $(a+b)^2$ to get the result.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\alpha + \\beta$ renders (Greek letters)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Let $\\alpha + \\beta = \\gamma$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\{1,2,3\\}$ renders (set notation)', async ({ page }) => {
    const r = await injectAndCheck(page, 'The set $\\{1,2,3\\}$ has three elements.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$a + b$ renders (simple with spaces)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Compute $a + b$ for the answer.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$f(x)$ renders (function notation)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Define $f(x)$ as the input function.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  // --- Math starting with digit ---

  test('$3x + 2y$ renders (digit then letter)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Solve $3x + 2y = 12$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$2^{10}$ renders (digit then caret)', async ({ page }) => {
    const r = await injectAndCheck(page, 'We know $2^{10} = 1024$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$3\\pi$ renders (digit then backslash)', async ({ page }) => {
    const r = await injectAndCheck(page, 'The angle is $3\\pi$ radians.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$10n$ renders (multi-digit then letter)', async ({ page }) => {
    const r = await injectAndCheck(page, 'The complexity is $10n$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$3 + 4 = 7$ renders (digit then space then operator)', async ({ page }) => {
    const r = await injectAndCheck(page, 'Simple: $3 + 4 = 7$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  // --- Mixed: currency and math in same message ---

  test('currency and math coexist correctly', async ({ page }) => {
    const r = await injectAndCheck(page,
      'The cost is $100 and the formula is $x^2 + y^2 = r^2$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
    expect(r.text).toContain('$100');
  });

  test('multiple math expressions with currency between them', async ({ page }) => {
    const r = await injectAndCheck(page,
      'Given $a = 1$ and $b = 2$, the total cost is $300.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(2);
    expect(r.text).toContain('$300');
  });

  // --- Hard edge cases: currency that could false-pair ---

  test('$5 then $10 in separate sentences', async ({ page }) => {
    const r = await injectAndCheck(page,
      'I have $5. He has $10. She has $20.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('($50) parenthesized currency', async ({ page }) => {
    const r = await injectAndCheck(page, 'The fee is ($50).', RENDER_WAIT);
    expect(r.katex).toBe(0);
    expect(r.text).toContain('$50');
  });

  test('$50/month currency with unit', async ({ page }) => {
    const r = await injectAndCheck(page, 'Costs $50/month per seat.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('$50+ currency with plus', async ({ page }) => {
    const r = await injectAndCheck(page, 'Must spend $50+ to qualify.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('~$50 approximate currency', async ({ page }) => {
    const r = await injectAndCheck(page, 'It costs ~$50 approximately.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('$50 to $100 range with words', async ({ page }) => {
    const r = await injectAndCheck(page, 'Price ranges from $50 to $100 per unit.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('$1M. sentence ending', async ({ page }) => {
    const r = await injectAndCheck(page, 'They raised $1M. Next round is $5M.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  test('$10/share currency with slash', async ({ page }) => {
    const r = await injectAndCheck(page, 'Stock price is $10/share today.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });

  // --- Hard edge cases: math that must render ---

  test('$O(n^2)$ big-O notation', async ({ page }) => {
    const r = await injectAndCheck(page, 'The algorithm runs in $O(n^2)$ time.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$n!$ factorial', async ({ page }) => {
    const r = await injectAndCheck(page, 'There are $n!$ permutations.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$|x|$ absolute value', async ({ page }) => {
    const r = await injectAndCheck(page, 'The absolute value is $|x|$ here.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\sqrt{2}$ square root', async ({ page }) => {
    const r = await injectAndCheck(page, 'It equals $\\sqrt{2}$ exactly.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\vec{v}$ vector notation', async ({ page }) => {
    const r = await injectAndCheck(page, 'Let $\\vec{v}$ be a vector.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$a_1, a_2, \\ldots, a_n$ sequence', async ({ page }) => {
    const r = await injectAndCheck(page, 'The sequence $a_1, a_2, \\ldots, a_n$ converges.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\binom{n}{k}$ binomial', async ({ page }) => {
    const r = await injectAndCheck(page, 'Choose $\\binom{n}{k}$ ways.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\overline{x}$ mean', async ({ page }) => {
    const r = await injectAndCheck(page, 'The mean is $\\overline{x}$ here.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$x \\in \\mathbb{R}$ set membership', async ({ page }) => {
    const r = await injectAndCheck(page, 'Where $x \\in \\mathbb{R}$ is real.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  test('$\\lim_{x \\to 0} f(x)$ limit', async ({ page }) => {
    const r = await injectAndCheck(page, 'Evaluate $\\lim_{x \\to 0} f(x)$ at zero.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1);
  });

  // --- Hard mixed: currency and math interleaved ---

  test('spend $5 on $x$ items', async ({ page }) => {
    const r = await injectAndCheck(page, 'Spend $5 on $x$ items.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1); // $x$ is math
    expect(r.text).toContain('$5');             // $5 is currency
  });

  test('$x$ is $5', async ({ page }) => {
    const r = await injectAndCheck(page, 'The variable $x$ is $5 today.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1); // $x$ is math
    expect(r.text).toContain('$5');             // $5 is currency
  });

  test('costs $5; the variable $x$ is 3', async ({ page }) => {
    const r = await injectAndCheck(page, 'It costs $5; the variable $x$ is 3.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(1); // $x$ is math
    expect(r.text).toContain('$5');             // $5 is currency
  });

  test('three math expressions in one sentence', async ({ page }) => {
    const r = await injectAndCheck(page,
      'If $a = 1$, $b = 2$, and $c = 3$, then $a + b + c = 6$.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(4);
  });

  test('dense math: $x$, $y$, and $z$ are variables', async ({ page }) => {
    const r = await injectAndCheck(page, 'Here $x$, $y$, and $z$ are variables.', RENDER_WAIT);
    expect(r.katex).toBeGreaterThanOrEqual(3);
  });

  // --- Adversarial: should NOT crash ---

  test('lone $ does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await injectAndCheck(page, 'That costs $ or more.', RENDER_WAIT);
    expect(errors).toEqual([]);
  });

  test('$$ with no content is display math not inline', async ({ page }) => {
    const r = await injectAndCheck(page, 'Before $$x = 1$$ after.', RENDER_WAIT);
    expect(r.katexDisplay).toBeGreaterThanOrEqual(1);
  });

  test('unmatched $ does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await injectAndCheck(page, 'The price is $ and then some text with no closing.', RENDER_WAIT);
    expect(errors).toEqual([]);
  });

  test('many $ in one message does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await injectAndCheck(page,
      'Prices: $10, $20, $30, $40, $50, $60, $70, $80, $90, $100.', RENDER_WAIT);
    expect(errors).toEqual([]);
    // None should render as math (all currency)
    const r = await injectAndCheck(page,
      'More: $10, $20, $30, $40, $50, $60, $70, $80, $90, $100.', RENDER_WAIT);
    expect(r.katex).toBe(0);
  });
});
