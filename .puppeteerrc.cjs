const { join } = require('path');

// Keep Chromium inside the project workspace so it survives any
// "fresh container at runtime" deploy model (Render, Fly, Cloud Run, etc.).
// .cache/ is git-ignored — the binary is re-downloaded during build by
// `npx puppeteer browsers install chrome`.
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
