/**
 * Server-side field-level encryption for DRT database at rest.
 * Uses AES-256-GCM via Node's built-in crypto module.
 *
 * Format: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * The "enc:v1:" prefix lets us distinguish encrypted values from plaintext
 * (important for migrating existing data transparently).
 */
const crypto = require('crypto');
const log = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const PREFIX = 'enc:v1:';

let _encryptionKey = null;

/**
 * Set the 32-byte encryption key (hex string from config).
 */
function setEncryptionKey(keyHex) {
  _encryptionKey = Buffer.from(keyHex, 'hex');
  if (_encryptionKey.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (64 hex chars)');
  }
}

/**
 * Encrypt a plaintext string. Returns the prefixed encrypted string.
 * Returns null/empty values as-is (no need to encrypt nothing).
 */
function encrypt(plaintext) {
  if (!plaintext || plaintext.length === 0) return plaintext;
  if (!_encryptionKey) throw new Error('Encryption key not initialized');

  // Don't double-encrypt
  if (typeof plaintext === 'string' && plaintext.startsWith(PREFIX)) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, _encryptionKey, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted string. If the value is not encrypted (no prefix),
 * returns it as-is — this allows transparent migration of existing plaintext data.
 */
function decrypt(encrypted) {
  if (!encrypted || encrypted.length === 0) return encrypted;

  // Not encrypted (legacy plaintext data) — return as-is
  if (typeof encrypted !== 'string' || !encrypted.startsWith(PREFIX)) return encrypted;

  if (!_encryptionKey) throw new Error('Encryption key not initialized');

  const stripped = encrypted.slice(PREFIX.length);
  const parts = stripped.split(':');
  if (parts.length !== 3) {
    log.warn('Malformed encrypted value — returning as-is');
    return encrypted;
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, _encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    log.error('Decryption failed:', e.message);
    // Return the raw value so the app doesn't crash — data may be corrupted or key changed
    return '[decryption failed]';
  }
}

/**
 * Check if a value is encrypted (has our prefix).
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { setEncryptionKey, encrypt, decrypt, isEncrypted };
