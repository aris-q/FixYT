#!/usr/bin/env node
/**
 * Shorts Feed dev server.
 * Serves static files + /api/* endpoints backed by yt-dlp.
 *
 * Usage:  node server.js
 * Then open the URL printed below on desktop or phone (same WiFi).
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const PORT  = parseInt(process.env.PORT || '3000', 10);
const DIR   = __dirname;
const YTDLP = (() => {
  try { return execSync('which yt-dlp', { encoding: 'utf8' }).trim(); }
  catch { return 'yt-dlp'; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
};

// ── yt-dlp runner ───────────────────────────────────────────────────────────
// Spawns yt-dlp, collects newline-delimited JSON, resolves with array of objects.

function ytdlp(args, timeoutMs = 40_000) {
  return new Promise((resolve, reject) => {
    const items = [];
    let buf = '';
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('yt-dlp timeout')); }, timeoutMs);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { items.push(JSON.parse(line)); } catch {} }
      }
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (buf.trim()) { try { items.push(JSON.parse(buf.trim())); } catch {} }
      resolve(items);
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Feed ────────────────────────────────────────────────────────────────────

// Hashtag pages return real Shorts (verified by yt-dlp author)
const FEED_SOURCES = [
  'https://www.youtube.com/hashtag/shorts',
  'https://www.youtube.com/hashtag/youtubeshorts',
  'https://www.youtube.com/hashtag/trending',
  'https://www.youtube.com/hashtag/viral',
  'https://www.youtube.com/hashtag/funny',
  'https://www.youtube.com/hashtag/satisfying',
];

const feedCache   = new Map(); // source → { items, ts }
const FEED_TTL_MS = 20 * 60 * 1000; // 20 min

async function getFeed(page) {
  const source = FEED_SOURCES[page % FEED_SOURCES.length];
  const hit    = feedCache.get(source);
  if (hit && Date.now() - hit.ts < FEED_TTL_MS) return hit.items;

  console.log(`  fetching feed page ${page}: ${source}`);

  const raw = await ytdlp([
    source,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--quiet',
    '--playlist-items', '1-25',
  ], 45_000);

  const items = raw
    .filter(v => v.id && v.duration != null && v.duration > 1 && v.duration <= 90)
    .map(v => ({
      videoId:   v.id,
      title:     v.title || '',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      uploader:  v.uploader || v.channel || v.uploader_id || '',
      viewCount: v.view_count ?? null,
      duration:  v.duration,
    }));

  feedCache.set(source, { items, ts: Date.now() });
  console.log(`  ✓ page ${page}: ${items.length} shorts`);
  return items;
}

// ── Stream ──────────────────────────────────────────────────────────────────

const streamCache   = new Map(); // videoId → { url, isHls, ts }
const streamPending = new Map(); // videoId → Promise
const STREAM_TTL_MS = 90 * 60 * 1000; // 90 min (YouTube URLs expire ~6hr)

function fetchStream(videoId) {
  const hit = streamCache.get(videoId);
  if (hit && Date.now() - hit.ts < STREAM_TTL_MS) return Promise.resolve(hit);
  if (streamPending.has(videoId)) return streamPending.get(videoId);

  const promise = (async () => {
    // Force a direct HTTPS videoplayback URL — NOT HLS.
    // HLS manifests (googlevideo.com) block XHR/fetch with CORS errors when
    // loaded by HLS.js. A plain <video src> on the other hand skips CORS
    // entirely, so a direct combined mp4 stream plays fine in any browser.
    const [info] = await ytdlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json',
      '--no-warnings',
      '--quiet',
      '-f',
      'best[height<=720][protocol=https][vcodec!=none][acodec!=none]' +
      '/best[height<=720][protocol=https]' +
      '/best[protocol=https]',
    ], 30_000);

    if (!info?.url) throw new Error('no url');

    const result = {
      url: info.url,
      ts:  Date.now(),
    };
    streamCache.set(videoId, result);
    streamPending.delete(videoId);
    return result;
  })();

  streamPending.set(videoId, promise);
  promise.catch(() => streamPending.delete(videoId));
  return promise;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function jsonRes(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p   = url.pathname;

  // ── /api/feed?page=N ───────────────────────────────────────────────────
  if (p === '/api/feed') {
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10));
    try {
      const items = await getFeed(page);
      jsonRes(res, { items });
    } catch (e) {
      console.error('[feed]', e.message);
      jsonRes(res, { items: [], error: e.message }, 502);
    }
    return;
  }

  // ── /api/stream?v=VIDEO_ID ─────────────────────────────────────────────
  if (p === '/api/stream') {
    const v = url.searchParams.get('v') ?? '';
    if (!/^[A-Za-z0-9_-]{5,15}$/.test(v)) { jsonRes(res, { error: 'bad id' }, 400); return; }
    try {
      const stream = await fetchStream(v);
      jsonRes(res, stream);
    } catch (e) {
      console.error('[stream]', v, e.message);
      jsonRes(res, { error: 'unavailable' }, 502);
    }
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────
  const rel  = p === '/' ? 'index.html' : p.slice(1);
  const full = path.resolve(DIR, rel);
  if (!full.startsWith(path.resolve(DIR))) { res.writeHead(403); res.end(); return; }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanIp();
  console.log(`\n  Shorts Feed`);
  console.log(`  Desktop  →  \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  if (lan) console.log(`  Phone    →  \x1b[36mhttp://${lan}:${PORT}\x1b[0m  (same WiFi)`);
  console.log('');

  // Warm up first page in background
  getFeed(0).catch(() => {});

  // Open desktop browser
  require('child_process').exec(`open http://localhost:${PORT}`);
});
