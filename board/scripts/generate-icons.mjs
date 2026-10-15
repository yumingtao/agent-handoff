#!/usr/bin/env node
/**
 * Generate all icon assets from the source SVG.
 *
 * Usage: node scripts/generate-icons.mjs
 *
 * Reads:  assets/app-icon.svg         (source of truth)
 * Outputs:
 *   - assets/app-icon.png            (1024×1024, for electron-builder general)
 *   - assets/app-icon.icns           (macOS icon bundle)
 *   - assets/icon.iconset/*.png      (macOS iconset, all sizes)
 *   - assets/tray-icon.svg           (18×18 tray/menu bar icon)
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const ASSETS = path.join(ROOT, 'assets');
const ICONSET = path.join(ASSETS, 'icon.iconset');

const SOURCE_SVG = path.join(ASSETS, 'app-icon.svg');

// macOS iconset sizes (name → pixel size)
const ICONSET_SIZES = [
  ['icon_16x16', 16],
  ['icon_16x16@2x', 32],
  ['icon_32x32', 32],
  ['icon_32x32@2x', 64],
  ['icon_128x128', 128],
  ['icon_128x128@2x', 256],
  ['icon_256x256', 256],
  ['icon_256x256@2x', 512],
  ['icon_512x512', 512],
  ['icon_512x512@2x', 1024],
];

// electron-builder expects these PNGs for non-mac platforms
const GENERAL_SIZES = [
  ['app-icon', 1024],
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  📁 Created: ${path.relative(ROOT, dir)}`);
  }
}

async function renderPng(svgBuffer, size, outPath) {
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  console.log(`  ✅ ${path.basename(outPath)}  ${size}×${size}`);
}

async function main() {
  console.log('🎨 Loop Engineering Board Icon Generator\n');

  // 1. Read source
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`❌ Source SVG not found: ${SOURCE_SVG}`);
    process.exit(1);
  }
  const svgBuffer = fs.readFileSync(SOURCE_SVG);
  console.log(`📖 Read source: ${path.relative(ROOT, SOURCE_SVG)} (${svgBuffer.length} bytes)\n`);

  // 2. Clean & recreate iconset directory
  if (fs.existsSync(ICONSET)) {
    fs.rmSync(ICONSET, { recursive: true });
  }
  ensureDir(ICONSET);

  // 3. Generate iconset PNGs
  console.log('📱 Generating macOS iconset...');
  for (const [name, size] of ICONSET_SIZES) {
    const outPath = path.join(ICONSET, `${name}.png`);
    await renderPng(svgBuffer, size, outPath);
  }

  // 4. Generate general-purpose PNG (1024×1024)
  console.log('\n🖼️  Generating general app icon...');
  for (const [name, size] of GENERAL_SIZES) {
    const outPath = path.join(ASSETS, `${name}.png`);
    await renderPng(svgBuffer, size, outPath);
  }

  // 5. Build .icns from iconset (macOS only)
  if (process.platform === 'darwin') {
    console.log('\n🍎  Building .icns bundle...');
    const { execSync } = await import('node:child_process');
    const icnsPath = path.join(ASSETS, 'app-icon.icns');
    if (fs.existsSync(icnsPath)) {
      fs.unlinkSync(icnsPath);
    }
    // iconutil requires an iconset named "icon.iconset" (which we already have)
    execSync(`iconutil -c icns "${ICONSET}" -o "${icnsPath}"`, { cwd: ROOT });
    console.log(`  ✅ app-icon.icns`);
  } else {
    console.log('\n⚠️  Skipping .icns generation (macOS only)');
    console.log('   On macOS, run: iconutil -c icns assets/icon.iconset -o assets/app-icon.icns');
  }

  // 6. Generate tray icon (simplified 18×18)
  console.log('\n🔧 Generating tray icon (simplified)...');
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" role="img" aria-label="Loop Engineering Board">
  <circle cx="5.5" cy="7" r="1.8" fill="#5b9cf6"/>
  <circle cx="12.5" cy="7" r="1.8" fill="#fbbf24"/>
  <circle cx="9" cy="12.5" r="1.8" fill="#34d399"/>
  <path d="M5.5 7 Q 7 10 9 12.5" fill="none" stroke="#34d399" stroke-width="0.8" stroke-linecap="round" opacity="0.85"/>
  <path d="M9 12.5 Q 11 10 12.5 7" fill="none" stroke="#fbbf24" stroke-width="0.8" stroke-linecap="round" opacity="0.85"/>
  <path d="M12.5 7 Q 9 4 5.5 7" fill="none" stroke="#5b9cf6" stroke-width="0.8" stroke-linecap="round" opacity="0.85"/>
</svg>`;
  const trayPath = path.join(ASSETS, 'tray-icon.svg');
  fs.writeFileSync(trayPath, traySvg, 'utf-8');
  console.log(`  ✅ tray-icon.svg (18×18 simplified)`);

  // Also generate PNG version for Electron Tray
  const trayPngPath = path.join(ASSETS, 'tray-icon.png');
  await sharp(Buffer.from(traySvg))
    .resize(32, 32)
    .png()
    .toFile(trayPngPath);
  console.log(`  ✅ tray-icon.png (32×32)`);

  console.log('\n🎉 Done! All assets generated.');
  console.log('\nOutput structure:');
  console.log('  assets/');
  console.log('  ├── app-icon.svg          (source)');
  console.log('  ├── app-icon.png          (1024×1024)');
  console.log('  ├── app-icon.icns         (macOS)');
  console.log('  ├── tray-icon.svg         (18×18)');
  console.log('  └── icon.iconset/         (all macOS sizes)');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
