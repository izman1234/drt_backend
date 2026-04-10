const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { DB_PATH } = require('./config');
const log = require('./logger');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    log.error('Failed to open database:', err.message);
    process.exit(1);
  }
  log.ok(`Database opened: ${DB_PATH}`);
});

// Initialize database tables
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    displayName TEXT NOT NULL,
    isOnline INTEGER DEFAULT 0,
    leftServer INTEGER DEFAULT 0,
    profilePicture LONGTEXT,
    nameColor TEXT DEFAULT '#a78bba',
    status TEXT DEFAULT 'offline',
    identityPublicKey TEXT,
    recoveryPublicKey TEXT,
    backupBlob TEXT,
    authVersion INTEGER DEFAULT 0,
    bio TEXT DEFAULT '',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Channels table
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    creatorId TEXT NOT NULL,
    \`order\` INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(creatorId) REFERENCES users(id)
  )`);

  // Messages table
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    image LONGTEXT,
    edited_at DATETIME,
    replyTo TEXT,
    signature TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channelId) REFERENCES channels(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  // Channel members table
  db.run(`CREATE TABLE IF NOT EXISTS channel_members (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    userId TEXT NOT NULL,
    joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channelId) REFERENCES channels(id),
    FOREIGN KEY(userId) REFERENCES users(id),
    UNIQUE(channelId, userId)
  )`);

  // Reactions table
  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    emoji TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(messageId) REFERENCES messages(id),
    FOREIGN KEY(userId) REFERENCES users(id),
    UNIQUE(messageId, userId, emoji)
  )`);
});

// Channel reads table (tracks per-user last read time per channel for unread indicators)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS channel_reads (
    userId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    lastReadAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(userId, channelId),
    FOREIGN KEY(userId) REFERENCES users(id),
    FOREIGN KEY(channelId) REFERENCES channels(id)
  )`);
});

// Create auth_challenges table for challenge-response authentication
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    challenge TEXT NOT NULL,
    type TEXT DEFAULT 'identity',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME NOT NULL,
    used INTEGER DEFAULT 0
  )`);
});

// Create key_audit_log table for key rotation history
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS key_audit_log (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    action TEXT NOT NULL,
    oldPublicKeyHash TEXT,
    newPublicKeyHash TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
});

// Seed: create a default "general" text channel on a fresh database
db.serialize(() => {
  db.get('SELECT COUNT(*) AS count FROM channels', (err, row) => {
    if (err || (row && row.count > 0)) return;
    const { randomUUID } = require('crypto');
    db.run(
      `INSERT INTO channels (id, name, description, type, creatorId, \`order\`) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), 'general', 'General discussion', 'text', 'system', 0],
      (insertErr) => {
        if (insertErr) log.error('Failed to seed default channel', insertErr);
        else log.ok('Created default #general channel');
      }
    );
  });
});

// ── Server management tables ──────────────────────────────────────────
// Owners — users who have admin-level access
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS owners (
    username TEXT PRIMARY KEY NOT NULL,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Bans — users who are not allowed to connect
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bans (
    username TEXT PRIMARY KEY NOT NULL,
    reason TEXT,
    bannedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Whitelist — users who are allowed to register/connect when whitelist mode is on
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS whitelist (
    username TEXT PRIMARY KEY NOT NULL,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ── Migrations ────────────────────────────────────────────────────────
// Add bio column to users table (for existing databases)
db.serialize(() => {
  db.all("PRAGMA table_info(users)", (err, cols) => {
    if (err) return;
    const hasBio = cols.some(c => c.name === 'bio');
    if (!hasBio) {
      db.run("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''", (alterErr) => {
        if (alterErr) log.error('Failed to add bio column:', alterErr.message);
        else log.ok('Added bio column to users table');
      });
    }
  });
});

module.exports = db;
