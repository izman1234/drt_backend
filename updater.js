/**
 * Auto-update module for DRT Server
 *
 * Checks GitHub Releases for newer versions and performs
 * self-update using a temporary helper-exe flow on Windows.
 *
 * Usage (called from main.js / index.js):
 *   Normal mode  — checkForUpdates(force?)  after server starts
 *   Helper mode  — applyUpdate()  invoked with --apply-update flag
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const https  = require('https');

// Logger — lightweight console wrapper, safe in helper mode
const log = require('./logger');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION — update these to match your GitHub repository
// ═══════════════════════════════════════════════════════════════════════
const GITHUB_OWNER        = 'izman1234';
const GITHUB_REPO         = 'drt_backend';
const EXE_ASSET_NAME      = 'DRT.Server.exe';
const CHECKSUM_ASSET_NAME = 'DRT.Server.exe.sha256';
const CHECK_INTERVAL_MS   = 24 * 60 * 60 * 1000;   // 24 hours

// ═══════════════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════════════
const BASE_DIR   = process.pkg ? path.dirname(process.execPath) : __dirname;
const STATE_FILE = path.join(BASE_DIR, 'update-state.json');

// ═══════════════════════════════════════════════════════════════════════
// Version helpers
// ═══════════════════════════════════════════════════════════════════════
function getCurrentVersion() {
  // Prefer the version recorded by a previous update (persisted on disk)
  // over the bundled package.json, which may be stale after self-update.
  try {
    const state = loadState();
    if (state.installedVersion) return state.installedVersion;
  } catch {}
  try { return require('./package.json').version; }
  catch { return '0.0.0'; }
}

function parseSemver(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function isNewer(latest, current) {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

// ═══════════════════════════════════════════════════════════════════════
// Persistent state (last-check timestamp)
// ═══════════════════════════════════════════════════════════════════════
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function saveState(patch) {
  try {
    const state = { ...loadState(), ...patch };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log.warn('Could not save update state:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Security — only fetch from GitHub-owned domains
// ═══════════════════════════════════════════════════════════════════════
function isGitHubUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'github.com'
        || h === 'api.github.com'
        || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════
// HTTPS helpers (built-in, no external deps)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simple HTTPS GET with redirect-following and GitHub-domain validation.
 * Returns a Buffer (default) or a readable stream (options.stream = true).
 */
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isGitHubUrl(url))
      return reject(new Error('Security: refusing non-GitHub URL: ' + url));

    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      port:     u.port || 443,
      headers: {
        'User-Agent': `DRT-Server/${getCurrentVersion()}`,
        ...(options.headers || {}),
      },
    };

    https.get(reqOpts, res => {
      // Follow redirects (302/301)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGet(res.headers.location, options).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${u.hostname}${u.pathname}`));
      }
      if (options.stream) return resolve(res);

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Download a URL to a local file (streaming, supports large binaries). */
function downloadFile(url, destPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const res = await httpsGet(url, { stream: true });
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;

      const file = fs.createWriteStream(destPath);

      res.on('data', chunk => {
        downloaded += chunk.length;
        if (totalBytes > 0 && process.stdout.isTTY) {
          const pct = Math.round((downloaded / totalBytes) * 100);
          const mb  = (downloaded / (1024 * 1024)).toFixed(1);
          process.stdout.write(`\r  Downloading... ${pct}% (${mb} MB)`);
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        if (totalBytes > 0 && process.stdout.isTTY) process.stdout.write('\n');
        file.close();
        resolve();
      });
      file.on('error', err => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    } catch (err) { reject(err); }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// SHA-256 verification
// ═══════════════════════════════════════════════════════════════════════
function computeSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Console prompt (Y/n)
// ═══════════════════════════════════════════════════════════════════════
// Use the server console's askQuestion() so we share the same readline
// instead of creating a conflicting second instance on stdin.
let _promptFn = null;

function setPromptFn(fn) { _promptFn = fn; }

function promptUser(question) {
  if (_promptFn) {
    return _promptFn(question).then(a => a.toLowerCase());
  }
  // Fallback for helper mode / non-interactive
  return new Promise(resolve => {
    if (!process.stdin.isTTY) return resolve('n');
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Permission helpers
// ═══════════════════════════════════════════════════════════════════════
function canWriteToDir(dir) {
  const probe = path.join(dir, '.drt-write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, 'test');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════
//  CHECK FOR UPDATES  (called from server startup)
// ═══════════════════════════════════════════════════════════════════════
async function checkForUpdates(force = false, { shutdownFn } = {}) {
  if (!process.pkg) {
    if (force) {
      log.info('Update check: running in development mode — auto-update not available.');
      log.info('Use git pull or build a new executable.');
    }
    return;
  }

  const currentVersion = getCurrentVersion();

  // ── Respect 24-hour cooldown ──────────────────────────────────────
  if (!force) {
    const state = loadState();
    if (state.lastCheckTimestamp) {
      const elapsed = Date.now() - state.lastCheckTimestamp;
      if (elapsed < CHECK_INTERVAL_MS) {
        log.debug('Update check skipped — last check was',
          Math.round(elapsed / 60000), 'minutes ago');
        return;
      }
    }
  }

  log.info('Checking for updates...');

  try {
    const apiUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const buf = await httpsGet(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    const release = JSON.parse(buf.toString());

    // Persist timestamp regardless of result
    saveState({ lastCheckTimestamp: Date.now() });

    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    if (!isNewer(latestVersion, currentVersion)) {
      log.info(`Up to date (v${currentVersion})`);
      return;
    }

    // ── Locate assets ─────────────────────────────────────────────────
    const exeAsset      = (release.assets || []).find(a => a.name === EXE_ASSET_NAME);
    const checksumAsset = (release.assets || []).find(a => a.name === CHECKSUM_ASSET_NAME);

    if (!exeAsset) {
      log.warn('Update available but release asset not found:', EXE_ASSET_NAME);
      return;
    }
    if (!checksumAsset) {
      log.warn('Update available but checksum asset not found — skipping for safety');
      return;
    }
    if (!isGitHubUrl(exeAsset.browser_download_url) ||
        !isGitHubUrl(checksumAsset.browser_download_url)) {
      log.warn('Release asset URLs do not point to GitHub — aborting for security');
      return;
    }

    // ── Prompt ────────────────────────────────────────────────────────
    log.info('');
    log.info(`  Update available (current v${currentVersion} → latest v${latestVersion})`);
    log.info(`  Release: ${release.html_url}`);
    log.info('');

    const answer = await promptUser('  Install update and restart now? [Y/n] ');
    if (answer !== '' && answer !== 'y' && answer !== 'yes') {
      log.info('Update declined.');
      return;
    }

    await downloadAndApply(latestVersion, exeAsset, checksumAsset, shutdownFn);

  } catch (err) {
    // Non-fatal — server keeps running
    log.warn('Update check failed (server continues normally):', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  DOWNLOAD, VERIFY & TRIGGER SELF-UPDATE
// ═══════════════════════════════════════════════════════════════════════
async function downloadAndApply(version, exeAsset, checksumAsset, shutdownFn) {
  const os      = require('os');
  const tempDir = path.join(os.tmpdir(), 'drt-update', version);
  const newExe  = path.join(tempDir, 'DRT Server.new.exe');
  const csFile  = path.join(tempDir, CHECKSUM_ASSET_NAME);

  // ── Permission check ────────────────────────────────────────────────
  const exeDir = path.dirname(process.execPath);
  if (!canWriteToDir(exeDir)) {
    log.error('');
    log.error('  Update requires elevated permissions.');
    log.error('  Re-run as Administrator, or install the server in a writable folder.');
    log.error('');
    return;
  }

  // ── Download exe ────────────────────────────────────────────────────
  log.info(`Downloading v${version}...`);
  await downloadFile(exeAsset.browser_download_url, newExe);
  log.info('Download complete.');

  // ── Download checksum ───────────────────────────────────────────────
  await downloadFile(checksumAsset.browser_download_url, csFile);

  // ── Verify SHA-256 ──────────────────────────────────────────────────
  log.info('Verifying integrity...');
  const expectedHash = fs.readFileSync(csFile, 'utf-8').trim().split(/\s+/)[0].toLowerCase();
  const actualHash   = await computeSHA256(newExe);

  if (actualHash !== expectedHash) {
    log.error('');
    log.error('  *** SHA-256 MISMATCH — update aborted! ***');
    log.error(`  Expected : ${expectedHash}`);
    log.error(`  Got      : ${actualHash}`);
    log.error('  The downloaded file may be corrupted or tampered with.');
    log.error('');
    try { fs.unlinkSync(newExe); } catch {}
    try { fs.unlinkSync(csFile); } catch {}
    return;
  }

  log.ok('Integrity verified (SHA-256 match).');

  // ── Launch helper ───────────────────────────────────────────────────
  // Copy current exe to a temp location so the file-lock on the real exe
  // is released when we exit. The temp copy performs the actual swap.
  const os_ = require('os');
  const helperPath = path.join(os_.tmpdir(), 'drt-update-helper.exe');

  log.info('Preparing update...');
  fs.copyFileSync(process.execPath, helperPath);

  const helperArgs = [
    '--apply-update',
    '--newExe',       newExe,
    '--targetExe',    process.execPath,
  ];

  log.info('');
  log.info('Shutting down server to apply update...');

  // Gracefully close the server so the port is released
  if (typeof shutdownFn === 'function') {
    try {
      await shutdownFn();
    } catch (err) {
      log.warn('Could not gracefully shut down server:', err.message);
    }
  }

  const child = require('child_process').spawn(helperPath, helperArgs, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.unref();

  // Exit so the OS releases the file lock on our exe
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════
//  APPLY UPDATE  (helper mode — runs from temp copy of the exe)
// ═══════════════════════════════════════════════════════════════════════
async function applyUpdate() {
  const args = process.argv;

  const idx = (flag) => args.indexOf(flag);
  const val = (flag) => { const i = idx(flag); return i !== -1 ? args[i + 1] : null; };

  const newExe    = val('--newExe');
  const targetExe = val('--targetExe');

  if (!newExe || !targetExe) {
    console.error('[updater] Missing --newExe or --targetExe');
    process.exit(1);
  }

  console.log('[updater] Applying update...');
  console.log('[updater] Source :', newExe);
  console.log('[updater] Target :', targetExe);

  // ── Wait for target exe to be unlocked ─────────────────────────────
  const maxWait = 30000;
  const t0 = Date.now();
  let unlocked = false;

  while (Date.now() - t0 < maxWait) {
    try {
      const fd = fs.openSync(targetExe, 'r+');
      fs.closeSync(fd);
      unlocked = true;
      break;
    } catch {
      await sleep(500);
    }
  }

  if (!unlocked) {
    console.error('[updater] Timed out waiting for exe to be released.');
    console.error('[updater] Close the server manually and re-run the update.');
    process.exit(1);
  }

  // ── Backup current exe ─────────────────────────────────────────────
  const backupPath = targetExe + '.old';
  try {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    if (fs.existsSync(targetExe)) {
      fs.renameSync(targetExe, backupPath);
      console.log('[updater] Backed up current exe →', backupPath);
    }
  } catch (err) {
    console.error('[updater] Backup failed:', err.message);
    process.exit(1);
  }

  // ── Copy new exe into place (copyFile works cross-volume) ──────────
  try {
    fs.copyFileSync(newExe, targetExe);
  } catch (err) {
    console.error('[updater] Install failed:', err.message);
    // Attempt restore
    try {
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetExe);
        console.log('[updater] Restored backup.');
      }
    } catch {}
    process.exit(1);
  }

  // ── Verify ─────────────────────────────────────────────────────────
  if (!fs.existsSync(targetExe) || fs.statSync(targetExe).size === 0) {
    console.error('[updater] Verification failed — file missing or empty');
    try {
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetExe);
        console.log('[updater] Restored backup.');
      }
    } catch {}
    process.exit(1);
  }

  // Clean up downloaded file (best effort)
  try { fs.unlinkSync(newExe); } catch {}

  // Record the installed version so getCurrentVersion() uses it
  // (the bundled package.json inside the new exe may still be stale).
  try {
    const targetDir = path.dirname(targetExe);
    const stateFile = path.join(targetDir, 'update-state.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch {}
    // Derive version from the temp dir name set during downloadAndApply
    const versionMatch = newExe.match(/drt-update[/\\]([^/\\]+)[/\\]/);
    if (versionMatch) st.installedVersion = versionMatch[1];
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf-8');
  } catch {}

  console.log('');
  console.log('  ============================================');
  console.log('  Update applied successfully!');
  console.log('  You can now restart the server.');
  console.log('  ============================================');
  console.log('');

  process.exit(0);
}

// ── tiny async sleep helper ──────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════
module.exports = { checkForUpdates, applyUpdate, getCurrentVersion, setPromptFn };
