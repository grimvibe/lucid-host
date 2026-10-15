// Minimal, dependency-free ZIP extractor with zip-slip and zip-bomb protection.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MAX_FILES = 10000;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function safeTarget(destDir, entryName) {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0")) {
    throw new Error(`Unsafe path in zip: ${entryName}`);
  }
  const target = path.resolve(destDir, normalized);
  if (target !== destDir && !target.startsWith(destDir + path.sep)) {
    throw new Error(`Unsafe path in zip: ${entryName}`);
  }
  return target;
}

function extractZip(buffer, destDir) {
  destDir = path.resolve(destDir);

  // Find the end-of-central-directory record.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file is not a valid zip archive");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error("Zip64 archives are not supported");
  }
  if (count > MAX_FILES) throw new Error("Zip contains too many files");

  fs.mkdirSync(destDir, { recursive: true });
  let total = 0;

  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip directory");

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const attrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);

    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error("Encrypted zip files are not supported");
    if (name.startsWith("__MACOSX/")) continue;
    if (((attrs >>> 16) & 0xf000) === 0xa000) continue; // skip symlinks

    const target = safeTarget(destDir, name);

    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error("Zip is too large once extracted");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Corrupt zip entry");
    const start = localOffset + 30 +
      buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: size + 1 });
    else throw new Error(`Unsupported compression method in ${name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = ((attrs >>> 16) & 0o111) ? 0o755 : 0o644;
    fs.writeFileSync(target, data, { mode });
  }
}

module.exports = { extractZip };
