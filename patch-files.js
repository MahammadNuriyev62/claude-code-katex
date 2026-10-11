const fs = require('fs');
const crypto = require('crypto');

// Stage every write before replacing any destination. Each replacement uses
// rename; if one fails, roll back replacements already made. This is not a
// crash-atomic transaction across files, but avoids truncated bundles and
// recovers from ordinary write/rename failures without an in-place fallback.
function replaceFiles(files) {
  const staged = [], committed = [];
  const suffix = `.katex-${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    for (const { target, body, expected } of files) {
      const exists = fs.existsSync(target);
      const original = exists ? fs.readFileSync(target) : null;
      if (expected !== undefined && (!original || !original.equals(expected))) {
        throw new Error('Claude Code files changed while preparing the patch; retry after the update finishes.');
      }
      const mode = exists ? fs.statSync(target).mode : undefined;
      const entry = { target, tmp: target + suffix, original, mode };
      staged.push(entry);
      fs.writeFileSync(entry.tmp, body, { flag: 'wx', mode });
    }
    // An extension update racing preparation must not be overwritten.
    for (const entry of staged) {
      const current = fs.existsSync(entry.target) ? fs.readFileSync(entry.target) : null;
      if (entry.original === null ? current !== null : !current || !current.equals(entry.original)) {
        throw new Error('Claude Code files changed while preparing the patch; retry after the update finishes.');
      }
    }
    for (const entry of staged) {
      fs.renameSync(entry.tmp, entry.target);
      committed.push(entry);
    }
  } catch (error) {
    for (const entry of committed.reverse()) {
      try {
        if (entry.original === null) fs.unlinkSync(entry.target);
        else {
          fs.writeFileSync(entry.tmp, entry.original, { flag: 'wx', mode: entry.mode });
          fs.renameSync(entry.tmp, entry.target);
        }
      } catch (rollbackError) {
        console.error('[Claude Code LaTeX] Could not roll back ' + entry.target + ': ' + rollbackError.message);
      }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      try { fs.unlinkSync(entry.tmp); } catch { /* already renamed or not created */ }
    }
  }
}

module.exports = { replaceFiles };
