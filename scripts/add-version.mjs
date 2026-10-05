#!/usr/bin/env node
// Adds one release zip to the VPM listing: its package.json, as the zip holds it, plus the zip's download URL and
// SHA-256, under packages.<name>.versions.<version> in index.json, and the version to the list in index.html. Earlier
// versions stay. A listed version never changes: adding the same zip again changes nothing, and a zip whose entry
// would differ is refused, because VCC and ALCOM check the downloaded bytes against zipSHA256.
//
//   node scripts/add-version.mjs <zip> [<url>]
//   node scripts/add-version.mjs --check
//
// <url> defaults to the release asset https://github.com/CucumberWorks/vpm/releases/download/<version>/<zip name>.
// --check validates index.json and index.html without changing them. Needs Node.js 22 or later and nothing else.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "index.json");
const PAGE = path.join(ROOT, "index.html");
const RELEASES = "https://github.com/CucumberWorks/vpm/releases/download";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The root package.json of a VPM zip: stored or deflated entries, no ZIP64. */
export function zipManifest(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP archive");
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("the ZIP central directory is corrupt");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (name !== "package.json") continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    const body = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!body) throw new Error(`package.json uses compression method ${method}`);
    return JSON.parse(body.toString("utf8"));
  }
  throw new Error("the zip has no package.json at its root, so VCC and ALCOM cannot install it");
}

// Packages re-served unchanged from their upstream release, whose own package.json names no author email: UniVRM's
// UniGLTF and VRM-1.0, which com.soulflame.vrm-exporter declares in vpmDependencies.
const UPSTREAM_PACKAGES = new Set(["com.vrmc.gltf", "com.vrmc.vrm"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

/** What is wrong with one version entry of the listing, listed under package `name` as `version`. */
export function checkVersionEntry(name, version, entry) {
  const where = `${name}@${version}`;
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`${where}: the version key is not semantic`);
  if (!isObject(entry)) return [...problems, `${where}: the entry is not an object`];
  if (entry.name !== name) problems.push(`${where}: name is ${entry.name}`);
  if (entry.version !== version) problems.push(`${where}: version is ${entry.version}`);
  if (!text(entry.displayName)) problems.push(`${where}: displayName is missing`);
  if (!/^\d+(?:\.\d+)?$/.test(entry.unity ?? "")) problems.push(`${where}: unity must be MAJOR or MAJOR.MINOR, or ALCOM drops the version`);
  if (!isObject(entry.author) || !text(entry.author.name)) problems.push(`${where}: author.name is missing`);
  else if (!text(entry.author.email) && !UPSTREAM_PACKAGES.has(name)) problems.push(`${where}: author.email is missing`);
  if (!/^https:\/\/\S+\.zip$/.test(entry.url ?? "")) problems.push(`${where}: url must be an https address of a .zip`);
  if (!/^[0-9a-f]{64}$/.test(entry.zipSHA256 ?? "")) problems.push(`${where}: zipSHA256 must be 64 lowercase hex digits`);
  if (entry.vpmDependencies !== undefined) {
    if (!isObject(entry.vpmDependencies)) problems.push(`${where}: vpmDependencies must be an object`);
    else for (const [dependency, range] of Object.entries(entry.vpmDependencies)) if (!text(range)) problems.push(`${where}: vpmDependencies.${dependency} must be a version range`);
  }
  return problems;
}

/** What is wrong with the listing: the five top-level fields, and each package's versions. */
export function checkListing(index) {
  const problems = [];
  if (!isObject(index)) return ["index.json is not an object"];
  if (!text(index.name)) problems.push("name is missing");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(index.id ?? "")) problems.push("id must be a reverse domain name, such as io.github.cucumberworks.vpm");
  if (!/^https:\/\/\S+\/index\.json$/.test(index.url ?? "")) problems.push("url must be the https address index.json is served from");
  if (!text(index.author)) problems.push("author is missing");
  if (!isObject(index.packages)) return [...problems, "packages must be an object"];
  for (const [name, entry] of Object.entries(index.packages)) {
    if (!isObject(entry) || !isObject(entry.versions)) {
      problems.push(`${name}: versions must be an object`);
      continue;
    }
    for (const [version, manifest] of Object.entries(entry.versions)) problems.push(...checkVersionEntry(name, version, manifest));
  }
  return problems;
}

/** The listing with the zip's version added; throws when the version is listed with other contents. */
export function addVersion(index, zip, url) {
  const manifest = zipManifest(zip);
  if ("url" in manifest || "zipSHA256" in manifest) throw new Error("the zip's package.json carries url or zipSHA256; the listing adds both");
  const entry = { ...manifest, url: url ?? `${RELEASES}/${manifest.version}/${manifest.name}-${manifest.version}.zip`, zipSHA256: createHash("sha256").update(zip).digest("hex") };
  const problems = checkVersionEntry(manifest.name, manifest.version, entry);
  if (problems.length) throw new Error(problems.join("\n"));
  const versions = index.packages?.[manifest.name]?.versions ?? {};
  const listed = versions[manifest.version];
  if (listed !== undefined) {
    if (JSON.stringify(listed) === JSON.stringify(entry)) return { index, entry, added: false };
    throw new Error(`${manifest.name} ${manifest.version} is already listed with other contents; a listed version never changes, so release a new version`);
  }
  const packages = { ...index.packages, [manifest.name]: { ...index.packages?.[manifest.name], versions: { ...versions, [manifest.version]: entry } } };
  return { index: { ...index, packages }, entry, added: true };
}

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Orders versions newest first, a pre-release before its release. */
function compareVersions(a, b) {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  for (let part = 1; part <= 3; part += 1) if (Number(x[part]) !== Number(y[part])) return Number(y[part]) - Number(x[part]);
  if (!x[4] !== !y[4]) return x[4] ? 1 : -1;
  return (y[4] ?? "").localeCompare(x[4] ?? "", "en", { numeric: true });
}

/** The package list of index.html, between its <!-- packages --> and <!-- /packages --> markers. */
export function packageList(index) {
  const items = Object.entries(index.packages).map(([name, entry]) => {
    const versions = Object.keys(entry.versions).sort(compareVersions);
    const display = entry.versions[versions[0]]?.displayName ?? name;
    const tags = versions.map((version) => `<li><code>${escapeHtml(version)}</code>${SEMVER.exec(version)[4] ? " (pre-release)" : ""}</li>`).join("\n        ");
    return `    <section>\n      <h2>${escapeHtml(display)}</h2>\n      <p><code>${escapeHtml(name)}</code></p>\n      <ul>\n        ${tags}\n      </ul>\n    </section>`;
  });
  return `<!-- packages -->\n${items.join("\n")}\n    <!-- /packages -->`;
}

function withPackageList(page, index) {
  const pattern = /<!-- packages -->[\s\S]*?<!-- \/packages -->/;
  if (!pattern.test(page)) throw new Error("index.html has no <!-- packages --> ... <!-- /packages --> block");
  return page.replace(pattern, packageList(index));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [first, url] = process.argv.slice(2);
    const index = JSON.parse(readFileSync(INDEX, "utf8"));
    const page = readFileSync(PAGE, "utf8");
    if (first === "--check") {
      const problems = checkListing(index);
      if (withPackageList(page, index) !== page) problems.push("index.html does not list the versions in index.json; run add-version again");
      if (problems.length) throw new Error(problems.join("\n"));
      console.log(`index.json is a valid listing: ${Object.entries(index.packages).map(([name, entry]) => `${name} ${Object.keys(entry.versions).join(", ")}`).join("; ")}`);
    } else if (first && !first.startsWith("--")) {
      const result = addVersion(index, readFileSync(first), url);
      const problems = checkListing(result.index);
      if (problems.length) throw new Error(problems.join("\n"));
      writeFileSync(INDEX, `${JSON.stringify(result.index, null, 2)}\n`);
      writeFileSync(PAGE, withPackageList(page, result.index));
      console.log(`${result.added ? "added" : "already listed, unchanged:"} ${result.entry.name} ${result.entry.version}`);
      console.log(`url ${result.entry.url}`);
      console.log(`zipSHA256 ${result.entry.zipSHA256}`);
    } else {
      throw new Error("usage: node scripts/add-version.mjs <zip> [<url>] | --check");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
