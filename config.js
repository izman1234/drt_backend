/**
 * Shared configuration for DRT backend.
 *
 * Priority: server-config.json  >  built-in defaults
 *
 * Auto-generates JWT_SECRET and ENCRYPTION_KEY on first run
 * and persists them to an encrypted secrets.dat file next to the executable.
 * (Secrets never live in plaintext or in the user-editable server-config.json.)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

// ── Resolve base directory ────────────────────────────────────────────
// When compiled with `pkg` the snapshot filesystem is read-only,
// so we write mutable files next to the executable instead of __dirname.
const BASE_DIR = process.pkg
  ? path.dirname(process.execPath)
  : __dirname;

// ── Ensure sqlite3 native addon exists on real filesystem ─────────────
// The addon is included in the pkg snapshot via the "assets" config,
// but native .node files must live on the real filesystem to be loaded.
// On first run we copy it out of the snapshot and hide the directory.
if (process.pkg) {
  const addonPath = path.join(
    BASE_DIR,
    'node_modules', 'sqlite3', 'build', 'Release', 'node_sqlite3.node'
  );
  if (!fs.existsSync(addonPath)) {
    try {
      // Read the addon from the pkg virtual filesystem (snapshot)
      const snapshotPath = path.join(
        __dirname, 'node_modules', 'sqlite3', 'build', 'Release', 'node_sqlite3.node'
      );
      const data = fs.readFileSync(snapshotPath);
      fs.mkdirSync(path.dirname(addonPath), { recursive: true });
      fs.writeFileSync(addonPath, data);
      log.info('Extracted sqlite3 native addon');

      // Hide node_modules/ so it doesn't clutter the user's folder
      if (process.platform === 'win32') {
        try {
          require('child_process').execSync(
            `attrib +h "${path.join(BASE_DIR, 'node_modules')}"`,
            { windowsHide: true }
          );
        } catch (e) { /* non-fatal */ }
      }
    } catch (e) {
      log.warn('Could not extract sqlite3 native addon:', e.message);
    }
  }
}

// ── Load user-editable config ─────────────────────────────────────────
const CONFIG_PATH = path.join(BASE_DIR, 'server-config.json');
let userConfig = {};

function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      log.info(`Loaded configuration from ${CONFIG_PATH}`);
    } else {
      // Write a default config file so the user can edit it
      const defaults = {
        serverName: 'DRT Server',
        serverIcon: null,
        port: 5000,
        dualProtocol: false,
        databasePath: './data/database.db',
        klipyApiKey: '',
        _comments: {
          serverIcon: 'Place an image file (e.g. server-icon.png) next to this config and set serverIcon to the filename. Supports png, jpg, gif, webp.',
          dualProtocol: 'When true, serves HTTP on PORT and HTTPS on PORT+1 (for development). When false (default), serves HTTPS only on PORT.',
          databasePath: 'Relative paths are resolved from the folder containing the executable.',
          klipyApiKey: 'API key for Klipy GIF service. Leave empty to disable GIF search.',
        },
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf-8');
      userConfig = defaults;
      log.info('Created default server-config.json — edit it to customise your server.');
    }
  } catch (err) {
    log.warn('Could not read server-config.json, using defaults:', err.message);
  }
}

loadUserConfig();

// Convenience accessor — config value > fallback
function cfg(key, fallback) {
  if (userConfig[key] !== undefined && userConfig[key] !== null && userConfig[key] !== '') {
    return userConfig[key];
  }
  return fallback;
}

// ── Public configuration values ───────────────────────────────────────
const SERVER_NAME    = cfg('serverName', 'DRT Server');
const PORT           = parseInt(cfg('port', 5000), 10);
const DUAL_PROTOCOL  = cfg('dualProtocol', false) === true;
const DB_PATH        = cfg('databasePath', './data/database.db');
const KLIPY_API_KEY  = cfg('klipyApiKey', '');

// ── Server icon ───────────────────────────────────────────────────────
// The user can either:
//   1. Put an image filename (e.g. "server-icon.png") — file must be next to the exe
//   2. Put a full data URI or URL directly
//   3. Leave null for no icon
function resolveServerIcon() {
  const raw = cfg('serverIcon', null);
  if (!raw) return null;

  // Already a data URI or URL
  if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }

  // Treat as a filename next to the executable
  const iconPath = path.isAbsolute(raw) ? raw : path.join(BASE_DIR, raw);
  try {
    if (fs.existsSync(iconPath)) {
      const ext = path.extname(iconPath).toLowerCase().replace('.', '');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/png';
      const data = fs.readFileSync(iconPath);
      log.info(`Loaded server icon from ${iconPath}`);
      return `data:${mime};base64,${data.toString('base64')}`;
    } else {
      log.warn(`Server icon file not found: ${iconPath}`);
      return null;
    }
  } catch (err) {
    log.warn('Failed to read server icon file:', err.message);
    return null;
  }
}

const SERVER_ICON = resolveServerIcon();

// Resolve DB_PATH relative to BASE_DIR so it works inside pkg
const resolvedDbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.resolve(BASE_DIR, DB_PATH);

// Ensure the database directory exists
const dbDir = path.dirname(resolvedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  log.info(`Created database directory: ${dbDir}`);
}
// ── Secrets (encrypted secrets.dat) ───────────────────────────────────
// Secrets are auto-generated and stored in an encrypted binary file
// next to the executable. This avoids leaving keys in plaintext .env files.
const SECRETS_PATH = path.join(BASE_DIR, 'secrets.dat');

/**
 * Derive a machine-local wrapping key from a stable fingerprint.
 * This isn't meant to be unbreakable — it prevents casual plaintext exposure.
 * The real security comes from filesystem permissions on the server.
 */
function deriveWrappingKey() {
  const os = require('os');
  // Use stable machine identifiers as salt for the wrapping key
  const material = [
    os.hostname(),
    os.platform(),
    os.arch(),
    BASE_DIR, // ties the secrets to this install location
  ].join('|');
  return crypto.createHash('sha256').update(material).digest(); // 32 bytes
}

/** Encrypt a JSON object and write it to secrets.dat */
function saveSecrets(data) {
  try {
    const key = deriveWrappingKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(data);
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: [iv 12B][authTag 16B][ciphertext ...]
    const out = Buffer.concat([iv, authTag, encrypted]);
    fs.writeFileSync(SECRETS_PATH, out);
  } catch (err) {
    log.warn('Could not write secrets.dat:', err.message);
  }
}

/** Read and decrypt secrets.dat, returns object or null */
function loadSecrets() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return null;
    const buf = fs.readFileSync(SECRETS_PATH);
    if (buf.length < 29) return null; // minimum: 12 iv + 16 tag + 1 data
    const key = deriveWrappingKey();
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, null, 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    log.warn('Could not read secrets.dat (will regenerate):', err.message);
    return null;
  }
}

const PLACEHOLDER_SECRETS = [
  'your_secret_key',
  'your_jwt_secret_key_change_this_in_production',
];

function initSecrets() {
  // Try loading existing encrypted secrets
  let secrets = loadSecrets();

  // Generate fresh secrets if needed
  if (!secrets) secrets = {};

  let changed = false;

  if (!secrets.jwtSecret || PLACEHOLDER_SECRETS.includes(secrets.jwtSecret)) {
    secrets.jwtSecret = crypto.randomBytes(64).toString('hex');
    log.info('Generated new JWT secret');
    changed = true;
  }

  if (!secrets.encryptionKey || secrets.encryptionKey.length !== 64) {
    secrets.encryptionKey = crypto.randomBytes(32).toString('hex');
    log.info('Generated new database encryption key');
    changed = true;
  }

  if (changed) {
    saveSecrets(secrets);
    log.ok('Secrets saved to encrypted secrets.dat');
  }

  return secrets;
}

const secrets = initSecrets();
const JWT_SECRET = secrets.jwtSecret;
const ENCRYPTION_KEY = secrets.encryptionKey;

// Initialize the encryption module with the key
const { setEncryptionKey } = require('./encryption');
setEncryptionKey(ENCRYPTION_KEY);

module.exports = {
  BASE_DIR,
  JWT_SECRET,
  ENCRYPTION_KEY,
  PORT,
  DUAL_PROTOCOL,
  DB_PATH: resolvedDbPath,
  SERVER_NAME,
  SERVER_ICON,
  KLIPY_API_KEY,
};
