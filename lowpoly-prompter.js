#!/usr/bin/env node
/**
 * Lowpoly Text-to-3D Prompter — browserless
 *
 * Usage: node lowpoly-prompter.js [--prompt "text"] [--style 通用|石雕|青花瓷|中国风|卡通|赛博朋克] [--topo triangle|quad]
 *
 * Requires: browser-session.json (run node downloader.js once to log in)
 */

const readline = require('readline');
const { generate, pollUntilDone } = require('./api');

const STYLES = ['通用', '石雕', '青花瓷', '中国风', '卡通', '赛博朋克'];
const TOPO_MAP = { triangle: 'triangle', quad: 'quad', '三角面': 'triangle', '四边面': 'quad' };

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { prompt: null, style: '', topo: 'triangle' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) opts.prompt = args[++i];
    else if (args[i] === '--style' && args[i + 1]) opts.style = args[++i];
    else if (args[i] === '--topo' && args[i + 1]) opts.topo = args[++i];
  }
  return opts;
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function run() {
  const opts = parseArgs();

  if (!opts.prompt) {
    opts.prompt = await ask('[?] Text prompt (e.g. "a cute cat sculpture"): ');
    if (!opts.prompt) throw new Error('prompt required');
  }

  if (opts.style && !STYLES.includes(opts.style)) {
    console.log(`[?] Available styles: ${STYLES.join(', ')}`);
    opts.style = await ask('[?] Style (default: 通用): ') || '';
  }

  const polygonType = TOPO_MAP[opts.topo] || 'triangle';

  console.log(`\n[Config] Prompt:   "${opts.prompt}"`);
  console.log(`[Config] Style:    ${opts.style || '通用 (default)'}`);
  console.log(`[Config] Topology: ${polygonType === 'quad' ? '四边面' : '三角面'}`);
  console.log('');

  console.log('[API] Submitting generation request...');
  const { status, data } = await generate({ prompt: opts.prompt, style: opts.style, polygonType });

  if (status !== 200) {
    throw new Error(`Generate failed: HTTP ${status} — ${JSON.stringify(data)?.slice(0, 200)}`);
  }

  const creationId = data?.id || data?.creationId || data?.creationsId || data?.data?.id;
  if (!creationId) {
    throw new Error(`No creation ID in response: ${JSON.stringify(data)?.slice(0, 300)}`);
  }

  console.log(`[API] ✓ Submitted — creation ID: ${creationId}`);
  console.log('[Poll] Waiting for generation to complete...\n');

  const result = await pollUntilDone(creationId);
  console.log('');

  if (result.status === 'done') {
    const variants = result.creation?.result || [];
    console.log(`[Done] ✓ Generation complete — ${variants.length} variant(s)`);
    for (const v of variants) {
      const urls = v.urlResult || {};
      if (urls.glb) console.log(`  GLB:  ${urls.glb}`);
    }
    console.log('[Done] Run node downloader.js to download assets.');
  } else if (result.status === 'failed') {
    console.error('[Done] ✗ Generation failed on server');
  } else {
    console.error('[Done] ✗ Timed out waiting for result');
  }
}

run().catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
