/**
 * Keeps `manifest.json` and `versions.json` in step with `package.json`.
 *
 * Obsidian requires the release's git tag to match `manifest.json`'s version *exactly* — no
 * `v` prefix — and a mismatch is rejected at submission rather than at build time. Running this
 * from `npm version` means the three files cannot drift apart by hand.
 *
 * `versions.json` maps each plugin version to the minimum Obsidian it needs, which is how older
 * clients know to offer an older release instead of one they cannot run.
 *
 * Usage: `npm version patch` (the `version` script in package.json invokes this).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error('No npm_package_version — run this through `npm version`, not directly.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`);

console.log(`manifest.json and versions.json set to ${targetVersion} (minAppVersion ${minAppVersion})`);
