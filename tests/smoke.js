const { chromium } = require('playwright-core');
(async () => {
  const port = require('fs').readFileSync('../.port', 'utf8');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const pg = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = []; pg.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text()); }); pg.on('pageerror', (e) => errs.push('PAGEERR ' + e.message + '\n' + e.stack));
  await pg.goto('http://127.0.0.1:' + port + '/');
  await pg.click('#btnPhantom'); await pg.waitForTimeout(500);
  await pg.click('#btnDemoMarkers'); await pg.waitForTimeout(800);
  await pg.screenshot({ path: 'out/dbg_mark.png' });
  for (const t of ['transfer', 'carm', 'summary']) { await pg.click(`#tabs button[data-tab=${t}]`); await pg.waitForTimeout(800); await pg.screenshot({ path: `out/dbg_${t}.png`, fullPage: true }); }
  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
