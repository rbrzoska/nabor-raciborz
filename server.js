/**
 * Dev server dla nabor-viewer
 * - serwuje pliki statyczne (index.html, data/)
 * - POST /api/scrape → uruchamia scraper.js i streamuje logi przez SSE
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8091;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

let scrapeProcess = null;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── SSE scrape stream ──────────────────────────────────────────────────────
  if (url.pathname === '/api/scrape') {
    if (scrapeProcess) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scraper już działa' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    const sse = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('log', { line: '⏳ Uruchamianie scrapera…' });

    scrapeProcess = spawn(process.execPath, ['scraper.js'], {
      cwd: __dirname,
      env: { ...process.env, NODE_PATH: join(__dirname, 'node_modules') },
    });

    const onData = chunk => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) sse('log', { line });
    };
    scrapeProcess.stdout.on('data', onData);
    scrapeProcess.stderr.on('data', onData);

    scrapeProcess.on('close', code => {
      sse('done', { success: code === 0, code });
      scrapeProcess = null;
      res.end();
    });

    req.on('close', () => {
      if (scrapeProcess) { scrapeProcess.kill(); scrapeProcess = null; }
    });
    return;
  }

  // ── Data API (mirrors Netlify function /api/data) ─────────────────────────
  if (url.pathname === '/api/data') {
    const dataFile = join(__dirname, 'data/raciborz.json');
    if (!existsSync(dataFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Brak danych. Uruchom: node scraper.js' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(readFileSync(dataFile));
    return;
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scraping: !!scrapeProcess }));
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = join(__dirname, filePath);

  if (!existsSync(filePath) || filePath.indexOf(__dirname) !== 0) {
    res.writeHead(404); res.end('Not found'); return;
  }

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(500); res.end('Server error');
  }

}).listen(PORT, () => console.log(`nabor-viewer → http://localhost:${PORT}`));
