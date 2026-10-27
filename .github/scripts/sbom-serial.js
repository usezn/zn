#!/usr/bin/env node
// Adds a deterministic serialNumber to a CycloneDX SBOM written during the release build.
// GitHub artifact attestations only accept a CycloneDX document that has bomFormat,
// specVersion and serialNumber, and the CycloneDX tools leave serialNumber out when
// they write reproducible output. The serial number is a name-based UUID (version 5)
// of the package name, version and the sha256 of the artifact the SBOM describes, so
// two builds of the same commit still write the same SBOM.
//
// Usage: node sbom-serial.js <sbom.cdx.json> <artifact>
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

// RFC 4122 URL namespace; the name below is a URL-like string, so this is the fitting one.
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(name, namespace = URL_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The serial number of a bom: the same package, version and artifact always give the same value.
function serialFor(name, version, artifactSha256) {
  return `urn:uuid:${uuidV5(`https://github.com/usezn/zn/sbom/${name}@${version}#sha256:${artifactSha256}`)}`;
}

// Returns the bom with serialNumber placed right after specVersion (the order the CycloneDX
// specification shows), keeping every other key and its order as it was.
function withSerial(bom, serial) {
  const out = {};
  for (const [k, v] of Object.entries(bom)) {
    if (k === 'serialNumber') continue;
    out[k] = v;
    if (k === 'specVersion') out.serialNumber = serial;
  }
  if (!('serialNumber' in out)) out.serialNumber = serial;
  return out;
}

function main() {
  const [file, artifact] = process.argv.slice(2);
  if (!file || !artifact) {
    console.error('usage: sbom-serial.js <sbom.cdx.json> <artifact>');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const bom = JSON.parse(text);
  const main = bom.metadata && bom.metadata.component;
  if (!main || !main.name || !main.version) {
    console.error(`::error::${file}: metadata.component name and version are needed for the serial number`);
    process.exit(1);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  const serial = serialFor(main.name, main.version, sha);
  const indent = (text.match(/^\{\r?\n([ \t]+)"/) || [null, '  '])[1];
  const eol = text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, JSON.stringify(withSerial(bom, serial), null, indent) + eol);
  console.log(`${file.split('/').pop()}: serialNumber ${serial}`);
}

if (require.main === module) main();

module.exports = { uuidV5, serialFor, withSerial };
