/**
 * set-version.mjs — set the release version in one place.
 *
 * Two manifests carry a version and they must agree: the repo root, and
 * `apps/desktop`, which is what `app.getVersion()` reports and what
 * electron-builder stamps into installer filenames. Editing them by hand is
 * how they drift, producing an installer called 0.2.0 that reports 0.1.0 in
 * its About box.
 *
 *   node scripts/set-version.mjs 0.2.0
 *   node scripts/set-version.mjs            # just print the current version
 *
 * The release workflow calls the same logic from a pushed tag, so a tagged
 * build and a local build produce identical output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = ['package.json', 'apps/desktop/package.json'];

/** Semver, optionally with a prerelease suffix (0.2.0-beta.1). */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function read(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

const requested = process.argv[2];

if (!requested) {
  for (const file of MANIFESTS) {
    console.log(`${file.padEnd(28)} ${read(file).version}`);
  }
  process.exit(0);
}

const version = requested.replace(/^v/, '');
if (!SEMVER.test(version)) {
  console.error(`Not a valid version: "${requested}"`);
  console.error('Expected something like 0.2.0 or 1.0.0-beta.1');
  process.exit(1);
}

for (const file of MANIFESTS) {
  const full = path.join(root, file);
  const manifest = read(file);
  manifest.version = version;
  // Trailing newline keeps the diff to the version line alone.
  fs.writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${file.padEnd(28)} -> ${version}`);
}

console.log(`
Next:
  git commit -am "release: v${version}"
  git tag v${version}
  git push origin main --tags

The tag starts the Release workflow, which builds installers for Windows,
macOS and Linux and opens a **draft** release for you to review.`);
