/**
 * Auto-generate a self-signed TLS certificate for the DRT backend.
 * The cert is generated once on first run and persisted in the certs/ directory.
 * Subsequent runs reuse the existing certificate.
 *
 * The SAN list includes localhost, 127.0.0.1, and every non-internal IPv4
 * address on the machine so the cert is valid for LAN connections too.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');
const { BASE_DIR } = require('./config');
const log = require('./logger');

const CERTS_DIR = path.join(BASE_DIR, 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');

/**
 * Get or create TLS credentials for the HTTPS server.
 * Returns a Promise that resolves to { key, cert } suitable for https.createServer(options).
 */
async function getTlsCredentials() {
  // If certs already exist, reuse them
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    log.info('Using existing TLS certificate from certs/');
    return {
      key: fs.readFileSync(KEY_PATH, 'utf8'),
      cert: fs.readFileSync(CERT_PATH, 'utf8'),
    };
  }

  log.info('Generating new self-signed TLS certificate...');

  // Ensure certs directory exists
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  const attrs = [{ name: 'commonName', value: 'DRT Server' }];

  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10); // 10 years

  // Build SAN list: localhost + every non-internal IPv4 address on this machine
  const altNames = [
    { type: 2, value: 'localhost' },       // DNS
    { type: 7, ip: '127.0.0.1' },          // loopback IPv4
    { type: 7, ip: '0.0.0.0' },            // wildcard
  ];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        altNames.push({ type: 7, ip: iface.address });
      }
    }
  }

  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'subjectAltName', altNames },
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  });

  fs.writeFileSync(KEY_PATH, pems.private, 'utf8');
  fs.writeFileSync(CERT_PATH, pems.cert, 'utf8');

  log.ok('TLS certificate generated and saved to certs/');

  return {
    key: pems.private,
    cert: pems.cert,
  };
}

module.exports = { getTlsCredentials, CERTS_DIR };
