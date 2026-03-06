/**
 * Build script for DRT Server — produces a single self-contained executable
 * with a custom taskbar / file-explorer icon.
 *
 * Strategy:
 *   1. Compile with pkg (produces exe with default Node.js icon)
 *   2. Split the exe into [PE binary] + [pkg appended payload]
 *   3. Apply rcedit to the PE-only portion (safe — standard PE file)
 *   4. Patch PAYLOAD_POSITION / PRELUDE_POSITION markers in the modified PE
 *      to account for any size change in the PE
 *   5. Recombine [modified PE] + [payload] → final exe with custom icon
 *
 * This avoids the two known failure modes:
 *   - Post-build rcedit (drops the appended payload)
 *   - Cache-base rcedit (pkg re-downloads when hash doesn't match)
 *
 * Usage:  node build.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST   = path.join(__dirname, 'dist');
const TARGET = 'node18-win-x64';
const OUT_NAME = 'DRT Server.exe';

// ── PE helpers ────────────────────────────────────────────────────────

/** Find the byte offset where OS PE sections end (= where pkg payload begins). */
function parsePeEnd(buf) {
  const e_lfanew = buf.readUInt32LE(0x3C);
  const numSections = buf.readUInt16LE(e_lfanew + 6);
  const optHeaderSize = buf.readUInt16LE(e_lfanew + 20);
  const sectionStart = e_lfanew + 24 + optHeaderSize;
  let peEnd = 0;
  for (let i = 0; i < numSections; i++) {
    const off = sectionStart + i * 40;
    const rawOffset = buf.readUInt32LE(off + 20);
    const rawSize   = buf.readUInt32LE(off + 16);
    const end = rawOffset + rawSize;
    if (end > peEnd) peEnd = end;
  }
  return peEnd;
}

// ── pkg position-marker helpers ───────────────────────────────────────
// pkg embeds offsets as padded JS string literals inside the binary:
//   var PAYLOAD_POSITION = '37574656                  ' | 0;
// We locate, read, and patch these after the PE is resized by rcedit.

function findPositionMarker(buf, name) {
  const needle = Buffer.from(name + " = '", 'latin1');
  const idx = buf.indexOf(needle);
  if (idx === -1) return null;

  const valueStart = idx + needle.length;
  const closeQuote = buf.indexOf(0x27, valueStart); // 0x27 = single-quote
  if (closeQuote === -1) return null;

  const raw = buf.subarray(valueStart, closeQuote).toString('latin1');
  return { offset: valueStart, length: closeQuote - valueStart, value: parseInt(raw.trim(), 10) };
}

function patchPositionMarker(buf, name, newValue) {
  const info = findPositionMarker(buf, name);
  if (!info) throw new Error('Cannot find ' + name + ' in binary — is this a pkg executable?');

  const padded = String(newValue).padEnd(info.length);
  if (padded.length !== info.length) throw new Error(name + ' value too large for padded field');
  buf.write(padded, info.offset, info.length, 'latin1');
}

// ── ICO builder ───────────────────────────────────────────────────────
// Windows Explorer needs multiple icon sizes (16, 32, 48, 256) for
// proper display across all view modes. We use sharp to resize the
// source PNG into each required size and pack them into one ICO.

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function buildIco(pngPath) {
  if (!fs.existsSync(pngPath)) return null;

  const sharp = require('sharp');
  const entries = [];

  for (const size of ICON_SIZES) {
    const pngBuf = await sharp(pngPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    entries.push({ size, data: pngBuf });
  }

  // ICO format: 6-byte header + 16-byte directory entry per image + image data
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * entries.length;
  let dataOffset = headerSize + dirSize;

  // Header
  const hdr = Buffer.alloc(headerSize);
  hdr.writeUInt16LE(0, 0);                        // reserved
  hdr.writeUInt16LE(1, 2);                        // type = icon
  hdr.writeUInt16LE(entries.length, 4);            // count

  // Directory entries
  const dirBufs = [];
  for (const entry of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0);  // width  (0 = 256)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1);  // height (0 = 256)
    dir.writeUInt8(0, 2);                          // colour palette
    dir.writeUInt8(0, 3);                          // reserved
    dir.writeUInt16LE(1, 4);                       // planes
    dir.writeUInt16LE(32, 6);                      // bpp
    dir.writeUInt32LE(entry.data.length, 8);       // image size
    dir.writeUInt32LE(dataOffset, 12);             // offset to data
    dataOffset += entry.data.length;
    dirBufs.push(dir);
  }

  return Buffer.concat([hdr, ...dirBufs, ...entries.map(e => e.data)]);
}

// ── Post-build icon injection ─────────────────────────────────────────
// Split exe → apply rcedit to PE half → patch pkg offsets → recombine

async function injectIcon(exePath, icoPath) {
  const exe = fs.readFileSync(exePath);
  const peEnd = parsePeEnd(exe);

  // Verify position markers exist before doing anything destructive
  const payloadInfo = findPositionMarker(exe, 'PAYLOAD_POSITION');
  const preludeInfo = findPositionMarker(exe, 'PRELUDE_POSITION');
  if (!payloadInfo || !preludeInfo) {
    console.warn('[build] WARNING: pkg position markers not found — skipping icon injection');
    return false;
  }

  console.log('[build] PE size:          ', peEnd, 'bytes');
  console.log('[build] PAYLOAD_POSITION: ', payloadInfo.value);
  console.log('[build] PRELUDE_POSITION: ', preludeInfo.value);

  // Split
  const pePart       = exe.subarray(0, peEnd);
  const appendedPart = exe.subarray(peEnd);

  // Write PE-only to temp file and apply rcedit
  const tempPe = exePath + '.pe';
  fs.writeFileSync(tempPe, pePart);

  try {
    const { rcedit } = await import('rcedit');
    await rcedit(tempPe, {
      icon: icoPath,
      'version-string': {
        ProductName:     'DRT Server',
        FileDescription: 'DRT Server',
      },
    });
  } catch (e) {
    console.warn('[build] WARNING: rcedit failed:', e.message);
    try { fs.unlinkSync(tempPe); } catch (_) {}
    return false;
  }

  // Read back modified PE
  const modifiedPe = fs.readFileSync(tempPe);
  fs.unlinkSync(tempPe);

  const delta = modifiedPe.length - pePart.length;
  console.log('[build] PE delta:         ', delta > 0 ? '+' + delta : delta, 'bytes');

  // Patch position markers in the modified PE
  patchPositionMarker(modifiedPe, 'PAYLOAD_POSITION', payloadInfo.value + delta);
  patchPositionMarker(modifiedPe, 'PRELUDE_POSITION', preludeInfo.value + delta);

  // Recombine and write back
  const final = Buffer.concat([modifiedPe, appendedPart]);
  fs.writeFileSync(exePath, final);

  console.log('[build] Icon injected and pkg offsets patched');
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────

(async () => {
  try {
    // 1. Clean dist/
    if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
    fs.mkdirSync(DIST, { recursive: true });

    // 2. Compile with pkg
    console.log(`\n[build] Compiling for ${TARGET}...`);
    execSync(
      `npx pkg . --targets ${TARGET} --output "${path.join(DIST, OUT_NAME)}"`,
      { stdio: 'inherit', cwd: __dirname }
    );

    // 3. Inject custom icon (post-build, split-and-recombine)
    const logoSrc = path.join(__dirname, 'images', 'logo.png');
    const icoData = await buildIco(logoSrc);
    if (icoData) {
      const icoPath = path.join(DIST, '_temp.ico');
      fs.writeFileSync(icoPath, icoData);

      console.log('\n[build] Injecting custom icon...');
      const ok = await injectIcon(path.join(DIST, OUT_NAME), icoPath);

      fs.unlinkSync(icoPath);
      if (!ok) console.warn('[build] Icon injection failed — exe will use default Node.js icon');
    } else {
      console.warn('[build] WARNING: images/logo.png not found — no icon');
    }

    // 4. Summary
    const outPath = path.join(DIST, OUT_NAME);
    const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
    console.log(`\n[build] Done! Output: dist/${OUT_NAME} (${sizeMB} MB)`);
    console.log('[build] Custom icon is baked in — no shortcut or .ico needed.');
    console.log('[build] First run auto-extracts dependencies and creates default config.');
  } catch (err) {
    console.error('\n[build] FATAL:', err.message);
    process.exit(1);
  }
})();
