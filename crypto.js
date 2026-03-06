/**
 * Server-side cryptographic utilities for DRT identity system.
 * Uses libsodium for Ed25519 signature verification and challenge generation.
 */
const sodium = require('libsodium-wrappers-sumo');
const log = require('./logger');
const crypto = require('crypto');

let _ready = null;

/**
 * Ensure libsodium WASM is initialized before any crypto operation.
 */
function ready() {
  if (!_ready) {
    _ready = sodium.ready;
  }
  return _ready;
}

/**
 * Generate a random 32-byte challenge, returned as base64.
 */
async function generateChallenge() {
  await ready();
  const challenge = sodium.randombytes_buf(32);
  return Buffer.from(challenge).toString('base64');
}

/**
 * Verify an Ed25519 detached signature.
 * @param {string} messageBase64  - The original message bytes as base64
 * @param {string} signatureBase64 - The 64-byte Ed25519 signature as base64
 * @param {string} publicKeyBase64 - The 32-byte Ed25519 public key as base64
 * @returns {boolean}
 */
async function verifySignature(messageBase64, signatureBase64, publicKeyBase64) {
  await ready();
  try {
    const message = new Uint8Array(Buffer.from(messageBase64, 'base64'));
    const signature = new Uint8Array(Buffer.from(signatureBase64, 'base64'));
    const publicKey = new Uint8Array(Buffer.from(publicKeyBase64, 'base64'));

    if (signature.length !== sodium.crypto_sign_BYTES) return false;
    if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false;

    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  } catch (e) {
    log.error('Signature verification error:', e.message);
    return false;
  }
}

/**
 * Verify a signature where the message is a UTF-8 string (for message authenticity).
 */
async function verifyStringSignature(messageString, signatureBase64, publicKeyBase64) {
  await ready();
  try {
    const message = sodium.from_string(messageString);
    const signature = new Uint8Array(Buffer.from(signatureBase64, 'base64'));
    const publicKey = new Uint8Array(Buffer.from(publicKeyBase64, 'base64'));

    if (signature.length !== sodium.crypto_sign_BYTES) return false;
    if (publicKey.length !== sodium.crypto_sign_PUBLICKEYBYTES) return false;

    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  } catch (e) {
    log.error('String signature verification error:', e.message);
    return false;
  }
}

/**
 * Hash a public key for audit logging (first 16 hex chars of SHA-256).
 */
function hashPublicKey(publicKeyBase64) {
  return crypto.createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex')
    .substring(0, 16);
}

module.exports = { ready, generateChallenge, verifySignature, verifyStringSignature, hashPublicKey };
