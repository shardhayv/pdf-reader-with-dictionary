#!/usr/bin/env node
'use strict';
/**
 * Generates the hicolor icon set from assets/icon.png into build/icons/.
 *
 * electron-builder only emitted a single 1024px icon from the source PNG,
 * which desktop environments then downscale on the fly for 16–48px slots —
 * visibly soft in the dock and application menu. Pointing linux.icon at a
 * directory of pre-rendered sizes fixes that.
 *
 * Uses Electron's own nativeImage, so there is no image-library dependency.
 * Run: npm run icons   (or automatically before packaging)
 */

const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SOURCE = path.join(__dirname, '..', 'assets', 'icon.png');
const OUT = path.join(__dirname, '..', 'build', 'icons');

function main() {
  const { app, nativeImage } = require('electron');

  app.whenReady().then(() => {
    const source = nativeImage.createFromPath(SOURCE);
    if (source.isEmpty()) {
      console.error(`could not read ${SOURCE}`);
      app.exit(1);
      return;
    }
    fs.mkdirSync(OUT, { recursive: true });
    for (const size of SIZES) {
      const resized = source.resize({ width: size, height: size, quality: 'best' });
      fs.writeFileSync(path.join(OUT, `${size}x${size}.png`), resized.toPNG());
    }
    console.log(`wrote ${SIZES.length} icons to build/icons/`);
    app.quit();
  });
}

main();
