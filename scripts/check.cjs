const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(!manifest.host_permissions, 'Access should be granted by activeTab only.');
const assets = [manifest.background.service_worker, manifest.action.default_popup, manifest.side_panel.default_path, 'reader.css', 'reader.js', 'popup.css', 'content.js', 'playback.js', 'offscreen.html', 'offscreen.js', 'vendor/mespeak/mespeak.js', 'vendor/mespeak/mespeak-core.js', ...Object.values(manifest.icons)];
for (const file of assets) assert.ok(fs.existsSync(path.join(root, file)), `Missing extension asset: ${file}`);
for (const file of ['background.js', 'playback.js', 'popup.js', 'content.js', 'offscreen.js', 'reader.js']) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
for (const file of ['popup.html', 'reader.html', 'offscreen.html']) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!/<script[^>]*\bsrc=["']https?:/i.test(html), 'Extension scripts must be bundled.');
  assert.ok(!/\son\w+\s*=/i.test(html), 'Inline event handlers violate extension CSP.');
}
assert.ok(Object.values(manifest.commands).filter((command) => command.suggested_key).length <= 4, 'Chrome permits four default keyboard shortcuts.');
assert.ok(manifest.permissions.includes('sidePanel'));
console.log('Manifest, bundled assets, CSP basics, and JavaScript syntax passed.');
