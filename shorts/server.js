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

// Keywords that surface high-quality destination content
const SEARCH_KEYWORDS = [
  'travel guide',
  'things to do',
  'travel vlog',
  'hidden gems',
  'must visit',
  'travel tips',
];

// YouTube's protobuf filter for Shorts-only search results
const SHORTS_SP = 'EgIYAQ%3D%3D';

// Minimum views to exclude low-quality / spam videos
const MIN_VIEWS = 100_000;

const feedCache   = new Map(); // cacheKey → { items, ts }
const FEED_TTL_MS = 20 * 60 * 1000; // 20 min

async function getFeed(page, location) {
  const kwIndex  = page % SEARCH_KEYWORDS.length;
  const kwRound  = Math.floor(page / SEARCH_KEYWORDS.length);
  const kw       = SEARCH_KEYWORDS[kwIndex];
  const query    = `${location} ${kw}`;
  const start    = kwRound * 20 + 1;   // 1, 21, 41, 61 … per keyword cycle
  const end      = start + 39;
  const cacheKey = `${query}:${start}`;
  const hit      = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < FEED_TTL_MS) return hit.items;

  console.log(`  fetching feed page ${page}: "${query}" items ${start}-${end}`);

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${SHORTS_SP}`;

  const raw = await ytdlp([
    searchUrl,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--quiet',
    '--playlist-items', `${start}-${end}`,
  ], 45_000);

  const items = raw
    .filter(v => v.id && v.duration != null && v.duration > 1 && v.duration <= 90)
    .filter(v => v.view_count == null || v.view_count >= MIN_VIEWS)
    .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))
    .slice(0, 20)
    .map(v => ({
      videoId:   v.id,
      title:     v.title || '',
      thumbnail: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
      uploader:  v.uploader || v.channel || v.uploader_id || '',
      viewCount: v.view_count ?? null,
      duration:  v.duration,
    }));

  feedCache.set(cacheKey, { items, ts: Date.now() });
  console.log(`  ✓ page ${page} "${query}": ${items.length} shorts (filtered from ${raw.length})`);

  // Warm up CDN URLs for the first few videos before the client asks
  items.slice(0, 4).forEach(item => getStreamUrl(item.videoId).catch(() => {}));

  return items;
}

// ── Stream URL resolver ──────────────────────────────────────────────────────
// Gets the direct CDN URL for a video (720p combined mp4 — no merge needed).
// The browser sets <video src="/api/proxy?v=ID">, we redirect to the CDN URL,
// and the browser streams directly at full CDN speed with no server buffering.

const streamCache   = new Map(); // videoId → { url, ts }
const streamPending = new Map(); // videoId → Promise<url>
const STREAM_TTL_MS = 90 * 60 * 1000; // YouTube CDN URLs last ~6 hr; refresh after 90 min

function getStreamUrl(videoId) {
  const hit = streamCache.get(videoId);
  if (hit && Date.now() - hit.ts < STREAM_TTL_MS) return Promise.resolve(hit.url);
  if (streamPending.has(videoId))                  return streamPending.get(videoId);

  const promise = (async () => {
    const [info] = await ytdlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--dump-json', '--no-warnings', '--quiet',
      '-f',
      'best[height<=1080][ext=mp4][vcodec!=none][acodec!=none]' +     // best combined ≤1080p mp4
      '/22' +                                                           // 720p combined mp4 (YouTube format code)
      '/best[height<=720][ext=mp4][vcodec!=none][acodec!=none]' +     // any 720p combined mp4
      '/best[height<=480][ext=mp4][vcodec!=none][acodec!=none]' +     // 480p combined mp4
      '/18' +                                                          // 360p combined mp4 (YouTube format code)
      '/best[ext=mp4][vcodec!=none][acodec!=none]' +                  // any combined mp4
      '/best[vcodec!=none][acodec!=none]' +                           // any combined stream
      '/best',
    ], 30_000);

    if (!info?.url) throw new Error('no url');
    streamCache.set(videoId, { url: info.url, ts: Date.now() });
    return info.url;
  })();

  streamPending.set(videoId, promise);
  promise.catch(() => {}).finally(() => streamPending.delete(videoId));
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

  // ── /api/feed?page=N&location=... ─────────────────────────────────────
  if (p === '/api/feed') {
    const page     = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10));
    const location = (url.searchParams.get('location') || '').trim().slice(0, 60);
    if (!location) { jsonRes(res, { items: [], error: 'location required' }, 400); return; }
    try {
      const items = await getFeed(page, location);
      jsonRes(res, { items });
    } catch (e) {
      console.error('[feed]', e.message);
      jsonRes(res, { items: [], error: e.message }, 502);
    }
    return;
  }

  // ── /api/proxy?v=VIDEO_ID — resolve CDN URL and redirect ─────────────────
  if (p === '/api/proxy') {
    const v = url.searchParams.get('v') ?? '';
    if (!/^[A-Za-z0-9_-]{5,15}$/.test(v)) { res.writeHead(400); res.end('bad id'); return; }
    try {
      const cdnUrl = await getStreamUrl(v);
      res.writeHead(302, { 'Location': cdnUrl, 'Cache-Control': 'no-store' });
      res.end();
    } catch (e) {
      console.error('[proxy]', v, e.message);
      res.writeHead(502); res.end('unavailable');
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

  // Open desktop browser
  require('child_process').exec(`open http://localhost:${PORT}`);
});
