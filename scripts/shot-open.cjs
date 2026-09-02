/**
 * shot-open.cjs — screenshot a panel with something CLICKED.
 *
 * `shot-html.cjs` captures a page at rest, which is fine for a form and
 * useless for anything that only exists after an interaction. The context
 * breakdown is exactly that: it opens on click, so every previous check of
 * it was by construction rather than by looking — and it was wrong twice.
 *
 *   npx electron scripts/shot-open.cjs <file.html> <out.png> <selector>
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const [input, output, selector] = process.argv.slice(2).filter((a) => !a.startsWith('-'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { sandbox: true, contextIsolation: true },
  });

  await win.loadFile(path.resolve(input));
  await new Promise((r) => setTimeout(r, 800));

  /*
   * A real click, not a synthetic state.
   *
   * The point is to exercise the same measuring and clamping the user's
   * click does — a rendered-open stand-in would prove the markup and
   * nothing about where it lands.
   */
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'no element for ${selector}';
      el.click();
      return 'clicked';
    })()
  `);
  console.log(clicked);

  await new Promise((r) => setTimeout(r, 500));

  const image = await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.resolve(output), image.toPNG());
  console.log(`captured ${output}`);
  app.quit();
});
