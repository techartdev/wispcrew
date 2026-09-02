/**
 * shot-html.cjs — screenshot a local HTML file with Electron.
 *
 * Companion to `shot-panels.cjs`. A panel that typechecks and whose classes
 * all exist can still look wrong; this is how that is checked without
 * clicking through the app to reach a modal three steps in.
 *
 *   npx electron scripts/shot-html.cjs <file.html> <out.png>
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('-'));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { sandbox: true, contextIsolation: true },
  });

  await win.loadFile(path.resolve(input));
  // A beat for fonts and layout; a capture taken too early shows unstyled text.
  await new Promise((r) => setTimeout(r, 1200));

  const image = await win.webContents.capturePage();
  require('node:fs').writeFileSync(path.resolve(output), image.toPNG());
  console.log(`captured ${output}`);
  app.quit();
});
