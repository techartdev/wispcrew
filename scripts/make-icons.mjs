/**
 * make-icons.mjs — rasterize the WispCrew mascot into every icon artifact.
 *
 * Source of truth: `build/icon.svg` (the Pac-Man-style ghost/squid).
 * Rendering is done by Electron's own Chromium, so there is no native image
 * dependency (no sharp/resvg) to install or rebuild per platform.
 *
 * Outputs:
 *   build/icon.png                  1024x1024 — electron-builder master icon
 *   build/icons/<size>.png          16..512   — Linux/dev + runtime window icon
 *   build/icon.ico                  Windows multi-resolution icon
 *
 * The in-app mascot is drawn as inline SVG by the renderer (`GhostMark` in
 * Sidebar.tsx), so it needs no raster asset here — keep the two in sync by
 * eye if you change `build/icon.svg`.
 *
 * Usage:
 *   node scripts/make-icons.mjs [--dry-run]
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(root, 'build', 'icon.svg');
const OUT_DIR = path.join(root, 'build');
const ICONS_DIR = path.join(OUT_DIR, 'icons');

const dryRun = process.argv.includes('--dry-run');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** Sizes embedded in the .ico (what Windows actually asks for). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Render the SVG at `size` and return raw PNG bytes.
 *
 * The page is written to a temp .html file rather than a data: URL — the
 * inlined SVG (with its XML prolog and comments) exceeds what Chromium will
 * accept as a data URL and fails with ERR_FAILED.
 */
async function renderPng(svgText, size, tmpDir) {
  // Always rasterize at a comfortable size and downscale with Chromium's
  // high-quality resampler. Creating tiny transparent offscreen windows is
  // unreliable on Windows (small sizes fail to load with ERR_FAILED), and
  // downscaling from a large master also yields cleaner small icons than
  // rendering vector text/AA directly at 16px.
  const RENDER_AT = 1024;
  const win = new BrowserWindow({
    width: RENDER_AT,
    height: RENDER_AT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true },
  });

  // Strip the XML prolog: it is only valid at the very start of a document,
  // and this SVG is being inlined into HTML.
  const inlineSvg = svgText.replace(/<\?xml[^>]*\?>\s*/i, '');

  // Fill the viewport exactly; no page margins, transparent backdrop.
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  svg{display:block;width:${RENDER_AT}px;height:${RENDER_AT}px}
</style>${inlineSvg}`;

  const page = path.join(tmpDir, `icon-${size}.html`);
  fs.writeFileSync(page, html, 'utf8');

  await win.loadFile(page);
  // One frame settle so gradients/AA are composited before capture.
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

/** Downscale a captured NativeImage to `size` and return PNG bytes. */
function toPngAt(image, size) {
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/**
 * Build a Windows .ico from PNG buffers (PNG-compressed ICO entries, which
 * Vista+ supports and electron-builder accepts).
 */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach(({ size, png }, i) => {
    const b = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, b + 0); // width (0 == 256)
    dir.writeUInt8(size >= 256 ? 0 : size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function write(file, buf) {
  if (dryRun) {
    console.log(`  would write ${path.relative(root, file)} (${buf.length} bytes)`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`  wrote ${path.relative(root, file)} (${buf.length} bytes)`);
}

async function main() {
  const svgText = fs.readFileSync(SVG, 'utf8');
  console.log(`Rendering ${path.relative(root, SVG)}${dryRun ? ' (dry run)' : ''}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispcrew-icons-'));
  const rendered = new Map();
  try {
    // Rasterize once at full resolution, then derive every size from it.
    const master = await renderPng(svgText, 1024, tmpDir);
    for (const size of SIZES) {
      rendered.set(size, toPngAt(master, size));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Master icon + per-size set.
  write(path.join(OUT_DIR, 'icon.png'), rendered.get(1024));
  for (const size of SIZES) {
    write(path.join(ICONS_DIR, `${size}x${size}.png`), rendered.get(size));
  }

  // Windows .ico
  write(
    path.join(OUT_DIR, 'icon.ico'),
    buildIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) }))),
  );

  console.log('Done.');
}

app.whenReady()
  .then(main)
  .catch((err) => {
    console.error('make-icons failed:', err);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
