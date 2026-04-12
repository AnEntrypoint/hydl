/**
 * Lowpoly Text-to-3D Prompter
 *
 * Prompts user for text input, selects options, submits to Hunyuan lowpoly
 * 文生3D (text-to-3D) endpoint, and polls until generation completes.
 *
 * Usage: node lowpoly-prompter.js [--prompt "text"] [--style通用|石雕|青花瓷|中国风|卡通|赛博朋克] [--topo triangle|quad]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SESSION_FILE = path.join(__dirname, 'browser-session.json');
const SESSION_VALID_DAYS = 30;
const LOWPOLY_URL = 'https://3d.hunyuan.tencent.com/lowpoly';

const STYLES = ['通用', '石雕', '青花瓷', '中国风', '卡通', '赛博朋克'];
const TOPO_MAP = { triangle: 'triangle', quad: 'quad', '三角面': 'triangle', '四边面': 'quad' };

function hasValidSession() {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const stat = fs.statSync(SESSION_FILE);
    const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays < SESSION_VALID_DAYS;
  } catch {
    return false;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { prompt: null, style: '通用', topo: 'triangle' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) opts.prompt = args[++i];
    else if (args[i] === '--style' && args[i + 1]) opts.style = args[++i];
    else if (args[i] === '--topo' && args[i + 1]) opts.topo = args[++i];
  }
  return opts;
}

async function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function setReactTextarea(page, selector, value) {
  await page.evaluate(({ sel, val }) => {
    const ta = document.querySelector(sel);
    if (!ta) throw new Error('textarea not found: ' + sel);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, val);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

async function selectStyle(page, styleName) {
  if (!styleName || styleName === '通用') return; // default selected
  await page.evaluate((name) => {
    const items = Array.from(document.querySelectorAll('.texture-item'));
    const target = items.find(el => el.querySelector('.item_name')?.textContent?.trim() === name);
    if (target) target.click();
    else throw new Error('style not found: ' + name);
  }, styleName);
}

async function selectTopology(page, topo) {
  // Find the visible topology radio group in 文生3D section (first one in sidebar)
  const polyType = TOPO_MAP[topo] || 'triangle';
  const labelText = polyType === 'quad' ? '四边面' : '三角面';
  await page.evaluate((label) => {
    // The sidebar-box__item contains the visible text2model section
    const sidebarItem = document.querySelector('.sidebar-box__item');
    const topoGroup = sidebarItem?.querySelectorAll('.t-radio-button');
    if (!topoGroup) return;
    for (const btn of topoGroup) {
      if (btn.textContent?.trim() === label) {
        btn.click();
        return;
      }
    }
  }, labelText);
}

async function waitForGeneration(page, timeoutMs = 300000) {
  console.log('[Gen] Polling for completion...');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await page.evaluate(() => {
      // Look for generation result cards or progress indicators
      const progressBar = document.querySelector('[class*="progress"], [class*="Progress"]');
      const resultCard = document.querySelector('[class*="result-card"], [class*="resultCard"], [class*="creation-item"]');
      const errorEl = document.querySelector('[class*="error"], [class*="Error"]');
      const bodyText = document.body.innerText;

      return {
        hasProgress: !!progressBar,
        hasResult: !!resultCard,
        hasError: !!errorEl,
        bodySnip: bodyText.slice(0, 200),
        genComplete: bodyText.includes('生成完成') || bodyText.includes('completed'),
        genFailed: bodyText.includes('生成失败') || bodyText.includes('failed'),
      };
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    if (status.genComplete) {
      console.log(`[Gen] ✓ Generation complete after ${elapsed}s`);
      return { success: true };
    }
    if (status.genFailed) {
      console.log(`[Gen] ✗ Generation failed after ${elapsed}s`);
      return { success: false, error: 'generation failed' };
    }

    process.stdout.write(`\r[Gen] Waiting... ${elapsed}s`);
    await page.waitForTimeout(3000);
  }

  console.log('\n[Gen] ✗ Timeout');
  return { success: false, error: 'timeout' };
}

async function run() {
  const opts = parseArgs();

  // Interactive prompts for missing args
  if (!opts.prompt) {
    opts.prompt = await promptUser('[?] Text prompt (e.g. "a cute cat sculpture"): ');
    if (!opts.prompt) throw new Error('prompt required');
  }

  if (!STYLES.includes(opts.style)) {
    console.log(`[?] Available styles: ${STYLES.join(', ')}`);
    opts.style = await promptUser('[?] Style (default: 通用): ') || '通用';
  }

  console.log(`\n[Config] Prompt:   "${opts.prompt}"`);
  console.log(`[Config] Style:    ${opts.style}`);
  console.log(`[Config] Topology: ${opts.topo === 'quad' ? '四边面' : '三角面'}`);
  console.log('');

  if (!hasValidSession()) {
    throw new Error('No valid session found. Run node downloader.js once to login first.');
  }

  console.log('[Init] Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    console.log('[Nav] Navigating to lowpoly...');
    await page.goto(LOWPOLY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Verify login
    const url = page.url();
    if (url.includes('/login')) {
      throw new Error('Session expired — re-run node downloader.js to refresh session');
    }

    // Ensure 文生3D tab is active
    console.log('[UI] Selecting 文生3D tab...');
    await page.evaluate(() => {
      const labels = document.querySelectorAll('.t-radio-button__label');
      for (const l of labels) {
        if (l.textContent?.trim() === '文生3D') {
          l.closest('.t-radio-button')?.click();
          return;
        }
      }
    });
    await page.waitForTimeout(500);

    // Set topology
    console.log('[UI] Setting topology...');
    await selectTopology(page, opts.topo);

    // Set texture style
    console.log('[UI] Setting texture style...');
    await selectStyle(page, opts.style);

    // Fill prompt
    console.log('[UI] Filling prompt...');
    await setReactTextarea(page, 'textarea.t-textarea__inner', opts.prompt);
    await page.waitForTimeout(500);

    // Verify textarea value
    const textareaVal = await page.$eval('textarea.t-textarea__inner', e => e.value);
    console.log(`[UI] Textarea: "${textareaVal}"`);

    // Click generate
    console.log('[UI] Clicking generate...');
    const btn = await page.$('.sideBarLeft-generateBtn');
    if (!btn) throw new Error('Generate button not found');
    await btn.click();

    console.log('[Gen] Submitted. Waiting for result...');
    const result = await waitForGeneration(page);

    if (result.success) {
      console.log('\n[Done] Generation complete! Asset visible on page.');
      console.log('[Done] You can now run node downloader.js to download it.');
    } else {
      console.error(`\n[Done] Generation failed: ${result.error}`);
    }

    // Save session
    await context.storageState({ path: SESSION_FILE });
    console.log('[Session] ✓ Saved');

    // Keep browser open briefly so user can see result
    await page.waitForTimeout(5000);

  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
