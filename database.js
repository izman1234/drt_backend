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
  // Users table — identityPublicKey is the primary identity
  db.run(`CREATE TABLE IF NOT EXISTS users (
    identityPublicKey TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    displayName TEXT NOT NULL,
    isOnline INTEGER DEFAULT 0,
    leftServer INTEGER DEFAULT 0,
    profilePicture LONGTEXT,
    nameColor TEXT DEFAULT '#a78bba',
    status TEXT DEFAULT 'offline',
    recoveryPublicKey TEXT,
    backupBlob TEXT,
    authVersion INTEGER DEFAULT 1,
    bio TEXT DEFAULT '',
    customStatus TEXT DEFAULT '',
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
    FOREIGN KEY(creatorId) REFERENCES users(identityPublicKey)
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
    FOREIGN KEY(userId) REFERENCES users(identityPublicKey)
  )`);

  // Channel members table
  db.run(`CREATE TABLE IF NOT EXISTS channel_members (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    userId TEXT NOT NULL,
    joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channelId) REFERENCES channels(id),
    FOREIGN KEY(userId) REFERENCES users(identityPublicKey),
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
    FOREIGN KEY(userId) REFERENCES users(identityPublicKey),
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
    FOREIGN KEY(userId) REFERENCES users(identityPublicKey),
    FOREIGN KEY(channelId) REFERENCES channels(id)
  )`);
});

// Create auth_challenges table for challenge-response authentication
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    publicKey TEXT NOT NULL,
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
    FOREIGN KEY(userId) REFERENCES users(identityPublicKey)
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
// Owners — identified by public key
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS owners (
    publicKey TEXT PRIMARY KEY NOT NULL,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Bans — identified by public key
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bans (
    publicKey TEXT PRIMARY KEY NOT NULL,
    reason TEXT,
    bannedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Whitelist — identified by public key
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS whitelist (
    publicKey TEXT PRIMARY KEY NOT NULL,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ── Migrations ────────────────────────────────────────────────────────

// Migration: from old UUID-based schema to public-key-based schema
db.serialize(() => {
  db.all("PRAGMA table_info(users)", (err, cols) => {
    if (err) return;
    const hasIdCol = cols.some(c => c.name === 'id');
    const hasIpkCol = cols.some(c => c.name === 'identityPublicKey');
    // Old schema has both 'id' (UUID PK) and 'identityPublicKey' columns
    if (!hasIdCol || !hasIpkCol) return;
    // Check if 'id' is the primary key (old schema)
    const idCol = cols.find(c => c.name === 'id');
    if (!idCol || idCol.pk !== 1) return;

    log.info('Migrating database from UUID-based schema to public-key-based schema...');

    // Build a mapping of old UUID -> identityPublicKey
    db.all("SELECT id, identityPublicKey, username FROM users WHERE identityPublicKey IS NOT NULL AND identityPublicKey != ''", (err, users) => {
      if (err) { log.error('Migration: failed to read users:', err.message); return; }
      if (!users || users.length === 0) {
        log.info('Migration: no migratable users found (no identityPublicKey set). Rebuilding tables...');
      }

      const idToKey = {};
      for (const u of (users || [])) {
        idToKey[u.id] = u.identityPublicKey;
      }

      db.run("BEGIN TRANSACTION", () => {
        // 1. Recreate users table
        db.run(`CREATE TABLE IF NOT EXISTS users_new (
          identityPublicKey TEXT PRIMARY KEY NOT NULL,
          username TEXT NOT NULL,
          displayName TEXT NOT NULL,
          isOnline INTEGER DEFAULT 0,
          leftServer INTEGER DEFAULT 0,
          profilePicture LONGTEXT,
          nameColor TEXT DEFAULT '#a78bba',
          status TEXT DEFAULT 'offline',
          recoveryPublicKey TEXT,
          backupBlob TEXT,
          authVersion INTEGER DEFAULT 1,
          bio TEXT DEFAULT '',
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
          db.run(`INSERT OR IGNORE INTO users_new (identityPublicKey, username, displayName, isOnline, leftServer, profilePicture, nameColor, status, recoveryPublicKey, backupBlob, authVersion, bio, createdAt)
            SELECT identityPublicKey, username, displayName, isOnline, leftServer, profilePicture, nameColor, status, recoveryPublicKey, backupBlob, COALESCE(authVersion, 1), COALESCE(bio, ''), createdAt
            FROM users WHERE identityPublicKey IS NOT NULL AND identityPublicKey != ''`, () => {

            // 2. Update FK columns in all related tables
            const updateFk = (table, col, callback) => {
              // Check if table has any rows referencing old UUIDs
              db.all(`SELECT DISTINCT ${col} FROM ${table}`, (err, rows) => {
                if (err) { callback(); return; }
                let pending = rows.length;
                if (pending === 0) { callback(); return; }
                for (const row of rows) {
                  const oldVal = row[col];
                  const newVal = idToKey[oldVal];
                  if (newVal && newVal !== oldVal) {
                    db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [newVal, oldVal], () => {
                      if (--pending === 0) callback();
                    });
                  } else {
                    if (--pending === 0) callback();
                  }
                }
              });
            };

            // Update all FK tables sequentially
            updateFk('channels', 'creatorId', () => {
              updateFk('messages', 'userId', () => {
                updateFk('channel_members', 'userId', () => {
                  updateFk('reactions', 'userId', () => {
                    updateFk('channel_reads', 'userId', () => {
                      updateFk('key_audit_log', 'userId', () => {

                        // 3. Migrate admin tables (bans, owners, whitelist) from username to publicKey
                        const migrateAdminTable = (oldTable, callback) => {
                          db.all(`PRAGMA table_info(${oldTable})`, (err, adminCols) => {
                            if (err) { callback(); return; }
                            const hasUsername = adminCols.some(c => c.name === 'username');
                            if (!hasUsername) { callback(); return; } // already migrated

                            db.all(`SELECT * FROM ${oldTable}`, (err, adminRows) => {
                              if (err) { callback(); return; }

                              const newTableName = `${oldTable}_new`;
                              if (oldTable === 'bans') {
                                db.run(`CREATE TABLE IF NOT EXISTS ${newTableName} (publicKey TEXT PRIMARY KEY NOT NULL, reason TEXT, bannedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`, () => {
                                  let p = adminRows.length;
                                  if (p === 0) { finishAdminMigration(oldTable, newTableName, callback); return; }
                                  for (const row of adminRows) {
                                    // Look up publicKey by username
                                    db.get("SELECT identityPublicKey FROM users WHERE username = ? AND identityPublicKey IS NOT NULL", [row.username], (err, u) => {
                                      if (u) {
                                        db.run(`INSERT OR IGNORE INTO ${newTableName} (publicKey, reason, bannedAt) VALUES (?, ?, ?)`, [u.identityPublicKey, row.reason, row.bannedAt]);
                                      } else {
                                        log.warn(`Migration: banned user "${row.username}" has no public key — skipping`);
                                      }
                                      if (--p === 0) finishAdminMigration(oldTable, newTableName, callback);
                                    });
                                  }
                                });
                              } else if (oldTable === 'owners') {
                                db.run(`CREATE TABLE IF NOT EXISTS ${newTableName} (publicKey TEXT PRIMARY KEY NOT NULL, addedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`, () => {
                                  let p = adminRows.length;
                                  if (p === 0) { finishAdminMigration(oldTable, newTableName, callback); return; }
                                  for (const row of adminRows) {
                                    db.get("SELECT identityPublicKey FROM users WHERE username = ? AND identityPublicKey IS NOT NULL", [row.username], (err, u) => {
                                      if (u) {
                                        db.run(`INSERT OR IGNORE INTO ${newTableName} (publicKey, addedAt) VALUES (?, ?)`, [u.identityPublicKey, row.addedAt]);
                                      } else {
                                        log.warn(`Migration: owner "${row.username}" has no public key — skipping`);
                                      }
                                      if (--p === 0) finishAdminMigration(oldTable, newTableName, callback);
                                    });
                                  }
                                });
                              } else if (oldTable === 'whitelist') {
                                db.run(`CREATE TABLE IF NOT EXISTS ${newTableName} (publicKey TEXT PRIMARY KEY NOT NULL, addedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`, () => {
                                  let p = adminRows.length;
                                  if (p === 0) { finishAdminMigration(oldTable, newTableName, callback); return; }
                                  for (const row of adminRows) {
                                    db.get("SELECT identityPublicKey FROM users WHERE username = ? AND identityPublicKey IS NOT NULL", [row.username], (err, u) => {
                                      if (u) {
                                        db.run(`INSERT OR IGNORE INTO ${newTableName} (publicKey, addedAt) VALUES (?, ?)`, [u.identityPublicKey, row.addedAt]);
                                      } else {
                                        log.warn(`Migration: whitelisted user "${row.username}" has no public key — skipping`);
                                      }
                                      if (--p === 0) finishAdminMigration(oldTable, newTableName, callback);
                                    });
                                  }
                                });
                              } else {
                                callback();
                              }
                            });
                          });
                        };

                        const finishAdminMigration = (oldTable, newTableName, callback) => {
                          db.run(`DROP TABLE IF EXISTS ${oldTable}`, () => {
                            db.run(`ALTER TABLE ${newTableName} RENAME TO ${oldTable}`, callback);
                          });
                        };

                        // Migrate admin tables, then swap users table
                        migrateAdminTable('bans', () => {
                          migrateAdminTable('owners', () => {
                            migrateAdminTable('whitelist', () => {

                              // 4. Migrate auth_challenges from username to publicKey
                              db.all("PRAGMA table_info(auth_challenges)", (err, chCols) => {
                                const hasUsernameCol = chCols && chCols.some(c => c.name === 'username');
                                const afterChallenges = () => {
                                  // 5. Swap users table
                                  db.run("DROP TABLE users", () => {
                                    db.run("ALTER TABLE users_new RENAME TO users", () => {
                                      db.run("COMMIT", () => {
                                        log.ok(`Migration complete. ${Object.keys(idToKey).length} user(s) migrated to public-key identity.`);
                                      });
                                    });
                                  });
                                };

                                if (hasUsernameCol) {
                                  // Recreate auth_challenges with publicKey column
                                  db.run(`CREATE TABLE IF NOT EXISTS auth_challenges_new (
                                    id TEXT PRIMARY KEY,
                                    publicKey TEXT NOT NULL,
                                    challenge TEXT NOT NULL,
                                    type TEXT DEFAULT 'identity',
                                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                                    expiresAt DATETIME NOT NULL,
                                    used INTEGER DEFAULT 0
                                  )`, () => {
                                    // Challenges are short-lived; just drop old data
                                    db.run("DROP TABLE auth_challenges", () => {
                                      db.run("ALTER TABLE auth_challenges_new RENAME TO auth_challenges", afterChallenges);
                                    });
                                  });
                                } else {
                                  afterChallenges();
                                }
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// Add bio column to users table (for existing databases, pre-migration)
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

// Add customStatus column to users table (for existing databases)
db.serialize(() => {
  db.all("PRAGMA table_info(users)", (err, cols) => {
    if (err) return;
    const hasCustomStatus = cols.some(c => c.name === 'customStatus');
    if (!hasCustomStatus) {
      db.run("ALTER TABLE users ADD COLUMN customStatus TEXT DEFAULT ''", (alterErr) => {
        if (alterErr) log.error('Failed to add customStatus column:', alterErr.message);
        else log.ok('Added customStatus column to users table');
      });
    }
  });
});

module.exports = db;
