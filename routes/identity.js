/**
 * Identity-based authentication routes for DRT.
 * Implements: registration, challenge/response auth, backup blob, key rotation.
 * 
 * All crypto verification uses Ed25519 via libsodium.
 * No plaintext secrets are ever stored on the server.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { ready, generateChallenge, verifySignature, hashPublicKey } = require('../crypto');

const { JWT_SECRET } = require('../config');
const log = require('../logger');

// ── Rate limiter (in-memory, per-IP) ──────────────────────────────────
const authAttempts = new Map();
const RATE_LIMIT_WINDOW = 20 * 1000; // 20 seconds
const RATE_LIMIT_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = authAttempts.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    authAttempts.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }
  record.count++;
  return true;
}

// Clean stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of authAttempts.entries()) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW) {
      authAttempts.delete(ip);
    }
  }
}, 60000);

// ── JWT verify middleware ─────────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ── Promisified DB helpers ────────────────────────────────────────────
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

module.exports = (io) => {
  const router = express.Router();

  // ────────────────────────────────────────────────────────────────────
  // POST /register — Register a new identity on this server
  // ────────────────────────────────────────────────────────────────────
  router.post('/register', async (req, res) => {
    try {
      await ready();
      const { username, displayName, identityPublicKey, recoveryPublicKey } = req.body;

      if (!username || !displayName || !identityPublicKey) {
        return res.status(400).json({ success: false, message: 'Missing required fields: username, displayName, identityPublicKey' });
      }

      // Validate Ed25519 public key (must be 32 bytes)
      const pubKeyBytes = Buffer.from(identityPublicKey, 'base64');
      if (pubKeyBytes.length !== 32) {
        return res.status(400).json({ success: false, message: 'Invalid identity public key (must be 32 bytes Ed25519)' });
      }

      if (recoveryPublicKey) {
        const recKeyBytes = Buffer.from(recoveryPublicKey, 'base64');
        if (recKeyBytes.length !== 32) {
          return res.status(400).json({ success: false, message: 'Invalid recovery public key' });
        }
      }

      const userId = uuidv4();

      try {
        await dbRun(
          `INSERT INTO users (id, username, displayName, identityPublicKey, recoveryPublicKey, authVersion)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [userId, username, displayName, identityPublicKey, recoveryPublicKey || null]
        );
      } catch (dbErr) {
        if (dbErr.message && dbErr.message.includes('UNIQUE')) {
          // If the existing user previously left, allow them to rejoin
          // by resetting their leftServer flag (same identity key required)
          const existing = await dbGet(
            'SELECT id, identityPublicKey, leftServer FROM users WHERE username = ?',
            [username]
          );
          if (existing && existing.leftServer === 1 && existing.identityPublicKey === identityPublicKey) {
            await dbRun(
              'UPDATE users SET leftServer = 0, displayName = ?, recoveryPublicKey = ? WHERE id = ?',
              [displayName, recoveryPublicKey || null, existing.id]
            );
            return res.json({ success: true, userId: existing.id, username, displayName });
          }
          return res.status(409).json({ success: false, message: 'Username already exists on this server' });
        }
        throw dbErr;
      }

      // Audit log
      await dbRun(
        'INSERT INTO key_audit_log (id, userId, action, newPublicKeyHash, createdAt) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), userId, 'registration', hashPublicKey(identityPublicKey), new Date().toISOString()]
      ).catch(e => log.error('Audit log error:', e.message));

      res.json({ success: true, userId, username, displayName });
    } catch (err) {
      log.error('Identity register error:', err);
      res.status(500).json({ success: false, message: 'Registration failed' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /challenge — Request a nonce for challenge-response auth
  // Body: { username, type: 'identity' | 'recovery' }
  // ────────────────────────────────────────────────────────────────────
  router.post('/challenge', async (req, res) => {
    try {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ success: false, message: 'Too many auth attempts. Try again later.' });
      }

      const { username, type = 'identity' } = req.body;
      if (!username) {
        return res.status(400).json({ success: false, message: 'Username is required' });
      }

      const user = await dbGet(
        'SELECT id, identityPublicKey, recoveryPublicKey, authVersion FROM users WHERE username = ?',
        [username]
      );

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found on this server' });
      }

      if (user.authVersion !== 1) {
        return res.status(400).json({
          success: false,
          message: 'Account uses incompatible auth version. Please create a new identity.'
        });
      }

      if (type === 'recovery' && !user.recoveryPublicKey) {
        return res.status(400).json({ success: false, message: 'No recovery key registered for this account' });
      }

      const challenge = await generateChallenge();
      const challengeId = uuidv4();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await dbRun(
        'INSERT INTO auth_challenges (id, username, challenge, type, expiresAt) VALUES (?, ?, ?, ?, ?)',
        [challengeId, username, challenge, type, expiresAt]
      );

      res.json({ success: true, challengeId, challenge });
    } catch (err) {
      log.error('Challenge error:', err);
      res.status(500).json({ success: false, message: 'Failed to create challenge' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /verify — Verify signed challenge → issue JWT
  // Body: { challengeId, signature }
  // ────────────────────────────────────────────────────────────────────
  router.post('/verify', async (req, res) => {
    try {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ success: false, message: 'Too many auth attempts' });
      }

      const { challengeId, signature } = req.body;
      if (!challengeId || !signature) {
        return res.status(400).json({ success: false, message: 'challengeId and signature are required' });
      }

      const challenge = await dbGet(
        'SELECT * FROM auth_challenges WHERE id = ? AND used = 0',
        [challengeId]
      );

      if (!challenge) {
        return res.status(400).json({ success: false, message: 'Invalid or already-used challenge' });
      }

      // Check expiry
      if (new Date(challenge.expiresAt) < new Date()) {
        await dbRun('DELETE FROM auth_challenges WHERE id = ?', [challengeId]);
        return res.status(400).json({ success: false, message: 'Challenge expired' });
      }

      // Mark as used immediately (prevent replay)
      await dbRun('UPDATE auth_challenges SET used = 1 WHERE id = ?', [challengeId]);

      const user = await dbGet(
        'SELECT id, username, displayName, identityPublicKey, recoveryPublicKey FROM users WHERE username = ?',
        [challenge.username]
      );

      if (!user) {
        return res.status(400).json({ success: false, message: 'User not found' });
      }

      // Choose verification key based on challenge type
      const publicKey = challenge.type === 'recovery'
        ? user.recoveryPublicKey
        : user.identityPublicKey;

      if (!publicKey) {
        return res.status(400).json({ success: false, message: 'No matching public key found' });
      }

      const isValid = await verifySignature(challenge.challenge, signature, publicKey);

      if (!isValid) {
        log.warn(`Auth failure for ${challenge.username} from ${ip} (type: ${challenge.type})`);
        return res.status(401).json({ success: false, message: 'Signature verification failed' });
      }

      // Issue JWT (7 day expiry)
      const token = jwt.sign(
        { userId: user.id, authType: challenge.type },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Clear leftServer flag if user is re-joining
      db.run('UPDATE users SET leftServer = 0 WHERE id = ?', [user.id]);

      res.json({
        success: true,
        token,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        identityPublicKey: user.identityPublicKey
      });
    } catch (err) {
      log.error('Verify error:', err);
      res.status(500).json({ success: false, message: 'Verification failed' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /check/:username — Check if user exists and auth version
  // ────────────────────────────────────────────────────────────────────
  router.get('/check/:username', async (req, res) => {
    try {
      const user = await dbGet(
        'SELECT id, authVersion, identityPublicKey FROM users WHERE username = ?',
        [req.params.username]
      );
      if (!user) {
        return res.json({ success: true, exists: false });
      }
      res.json({
        success: true,
        exists: true,
        authVersion: user.authVersion || 0,
        identityPublicKey: user.identityPublicKey || null
      });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // PUT /backup-blob — Upload encrypted backup blob (authenticated)
  // ────────────────────────────────────────────────────────────────────
  router.put('/backup-blob', verifyToken, async (req, res) => {
    try {
      const { blob } = req.body;
      if (!blob) {
        return res.status(400).json({ success: false, message: 'Blob is required' });
      }

      const blobStr = typeof blob === 'string' ? blob : JSON.stringify(blob);
      if (blobStr.length > 1024 * 1024) {
        return res.status(400).json({ success: false, message: 'Backup blob exceeds 1 MB limit' });
      }

      await dbRun('UPDATE users SET backupBlob = ? WHERE id = ?', [blobStr, req.userId]);
      res.json({ success: true, message: 'Backup blob stored' });
    } catch (err) {
      log.error('Backup blob upload error:', err);
      res.status(500).json({ success: false, message: 'Failed to store backup' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /backup-blob/download — Download backup blob (recovery-key auth)
  // Body: { username, challengeId, signature }
  // Requires a recovery-type challenge.
  // ────────────────────────────────────────────────────────────────────
  router.post('/backup-blob/download', async (req, res) => {
    try {
      const { username, challengeId, signature } = req.body;
      if (!username || !challengeId || !signature) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const challenge = await dbGet(
        'SELECT * FROM auth_challenges WHERE id = ? AND used = 0 AND type = ?',
        [challengeId, 'recovery']
      );

      if (!challenge) {
        return res.status(400).json({ success: false, message: 'Invalid or expired recovery challenge' });
      }

      if (new Date(challenge.expiresAt) < new Date()) {
        return res.status(400).json({ success: false, message: 'Challenge expired' });
      }

      await dbRun('UPDATE auth_challenges SET used = 1 WHERE id = ?', [challengeId]);

      const user = await dbGet(
        'SELECT recoveryPublicKey, backupBlob FROM users WHERE username = ?',
        [username]
      );

      if (!user || !user.recoveryPublicKey) {
        return res.status(404).json({ success: false, message: 'User or recovery key not found' });
      }

      const isValid = await verifySignature(challenge.challenge, signature, user.recoveryPublicKey);
      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Recovery key verification failed' });
      }

      if (!user.backupBlob) {
        return res.status(404).json({ success: false, message: 'No backup blob stored on this server' });
      }

      res.json({ success: true, blob: user.backupBlob });
    } catch (err) {
      log.error('Backup blob download error:', err);
      res.status(500).json({ success: false, message: 'Failed to retrieve backup' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /rotate-key — Rotate identity key (recovery-key auth required)
  // Body: { username, newIdentityPublicKey, challengeId, signature }
  // ────────────────────────────────────────────────────────────────────
  router.post('/rotate-key', async (req, res) => {
    try {
      await ready();
      const { username, newIdentityPublicKey, challengeId, signature } = req.body;

      if (!username || !newIdentityPublicKey || !challengeId || !signature) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const newPubKeyBytes = Buffer.from(newIdentityPublicKey, 'base64');
      if (newPubKeyBytes.length !== 32) {
        return res.status(400).json({ success: false, message: 'Invalid new identity public key' });
      }

      const challenge = await dbGet(
        'SELECT * FROM auth_challenges WHERE id = ? AND used = 0 AND type = ?',
        [challengeId, 'recovery']
      );

      if (!challenge) {
        return res.status(400).json({ success: false, message: 'Invalid recovery challenge' });
      }

      if (new Date(challenge.expiresAt) < new Date()) {
        return res.status(400).json({ success: false, message: 'Challenge expired' });
      }

      await dbRun('UPDATE auth_challenges SET used = 1 WHERE id = ?', [challengeId]);

      const user = await dbGet(
        'SELECT id, identityPublicKey, recoveryPublicKey FROM users WHERE username = ?',
        [username]
      );

      if (!user || !user.recoveryPublicKey) {
        return res.status(404).json({ success: false, message: 'User not found or no recovery key' });
      }

      const isValid = await verifySignature(challenge.challenge, signature, user.recoveryPublicKey);
      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Recovery key verification failed' });
      }

      const oldKeyHash = user.identityPublicKey ? hashPublicKey(user.identityPublicKey) : 'none';
      const newKeyHash = hashPublicKey(newIdentityPublicKey);

      await dbRun(
        'UPDATE users SET identityPublicKey = ? WHERE id = ?',
        [newIdentityPublicKey, user.id]
      );

      // Audit trail
      await dbRun(
        'INSERT INTO key_audit_log (id, userId, action, oldPublicKeyHash, newPublicKeyHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), user.id, 'key_rotation', oldKeyHash, newKeyHash, new Date().toISOString()]
      ).catch(e => log.error('Audit log error:', e.message));

      res.json({ success: true, message: 'Identity key rotated successfully' });
    } catch (err) {
      log.error('Key rotation error:', err);
      res.status(500).json({ success: false, message: 'Key rotation failed' });
    }
  });

  // ── Periodic cleanup of expired/used challenges ─────────────────────
  setInterval(() => {
    db.run(
      'DELETE FROM auth_challenges WHERE expiresAt < ? OR used = 1',
      [new Date().toISOString()]
    );
  }, 60000);

  return router;
};
