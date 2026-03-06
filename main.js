#!/usr/bin/env node
/**
 * DRT Server — entry point
 *
 * Routes to the appropriate mode:
 *   --version / -v      Print version and exit
 *   --apply-update      Run the update-helper flow (swap binaries)
 *   (default)           Start the server normally
 *
 * This thin wrapper exists so the update-helper mode can run WITHOUT
 * loading any heavy server modules (database, config, express, …).
 */

'use strict';

// ── Version flag ──────────────────────────────────────────────────────
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const version = require('./package.json').version;
  console.log(`DRT Server v${version}`);
  process.exit(0);
}

// ── Update-helper mode ────────────────────────────────────────────────
// When the server needs to update itself it copies the exe to %TEMP%
// and re-launches it with --apply-update.  That copy lands here.
// Only the updater module is loaded — no database, no express.
if (process.argv.includes('--apply-update')) {
  require('./updater').applyUpdate().catch(err => {
    console.error('[updater] Fatal:', err.message);
    process.exit(1);
  });
} else {
  // ── Normal server startup ───────────────────────────────────────────
  require('./index');
}
