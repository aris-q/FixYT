// When served via HTTP (localhost OR phone via LAN), use the local yt-dlp proxy.
// Opening index.html as file:// won't work — you must run: node server.js
const USE_PROXY = location.protocol.startsWith('http');

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  feedPage:    0,
  isFetching:  false,
  globalMuted: true,
  totalLoaded: 0,
  location:    '',
  seenIds:     new Set(),
};

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(path, timeoutMs = 45_000) {
  if (!USE_PROXY) {
    showNoServer();
    throw new Error('Not running via server.js');
  }
  const res = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Feed ──────────────────────────────────────────────────────────────────────

async function fetchBatch(retries = 5) {
  if (state.isFetching) return;
  state.isFetching = true;
  try {
    const data = await apiFetch(`/api/feed?page=${state.feedPage}&location=${encodeURIComponent(state.location)}`);
    state.feedPage++;
    const added = appendCards(data.items ?? []);
    // Sentinel stays visible but observer won't re-fire if nothing was added;
    // advance to the next page automatically (up to retries times).
    if (added === 0 && retries > 0) {
      state.isFetching = false;
      fetchBatch(retries - 1);
      return;
    }
  } catch (err) {
    console.error('[feed]', err.message);
    if (state.totalLoaded === 0) showError();
  } finally {
    state.isFetching = false;
  }
}

// ── Card creation ─────────────────────────────────────────────────────────────

function fmtViews(n) {
  if (n == null) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K views';
  return n + ' views';
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function createCard(item) {
  const { videoId, title, thumbnail, uploader, viewCount } = item;
  if (!videoId) return null;

  const ytUrl = `https://www.youtube.com/shorts/${videoId}`;

  const card = document.createElement('div');
  card.className = 'short-card';
  card.dataset.videoId = videoId;

  card.innerHTML = `
    <div class="card-thumb" style="background-image:url('${esc(thumbnail)}')"></div>
    <video class="card-video" loop playsinline></video>
    <div class="card-spinner"></div>
    <div class="tap-indicator">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </div>
    <div class="card-overlay">
      <div class="overlay-side">
        <a href="${ytUrl}" target="_blank" rel="noopener noreferrer"
           class="side-btn" title="Open on YouTube"
           onclick="event.stopPropagation()">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
        </a>
      </div>
      <div class="overlay-bottom">
        <div class="meta-uploader">${esc(uploader)}</div>
        <div class="meta-title">${esc(title)}</div>
        ${viewCount ? `<div class="meta-views">${fmtViews(viewCount)}</div>` : ''}
      </div>
    </div>
  `;

  // Fallback: maxresdefault may 404 for rare videos; swap to hqdefault silently
  const thumbEl = card.querySelector('.card-thumb');
  const testImg = new Image();
  testImg.onerror = () => {
    thumbEl.style.backgroundImage = `url('https://i.ytimg.com/vi/${videoId}/hqdefault.jpg')`;
  };
  testImg.src = thumbnail;

  card.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    onCardClick(card);
  });

  return card;
}

function appendCards(items) {
  const feed     = document.getElementById('feed');
  const sentinel = document.getElementById('sentinel');
  let added = 0;
  items.forEach(item => {
    if (state.seenIds.has(item.videoId)) return;
    state.seenIds.add(item.videoId);
    const card = createCard(item);
    if (!card) return;
    feed.insertBefore(card, sentinel);
    playObserver.observe(card);
    state.totalLoaded++;
    added++;
  });
  return added;
}

// ── Stream loading ────────────────────────────────────────────────────────────

function loadStream(card) {
  if (card.dataset.streamLoaded) return Promise.resolve(true);

  const spinner = card.querySelector('.card-spinner');
  const video   = card.querySelector('.card-video');

  spinner.classList.add('active');

  if (!video.src) {
    video.src   = `/api/proxy?v=${card.dataset.videoId}`;
    video.muted = state.globalMuted;
  }

  // canplay may have already fired if prefetch completed while viewing a previous card
  if (video.readyState >= 3) {
    spinner.classList.remove('active');
    card.dataset.streamLoaded = '1';
    return Promise.resolve(true);
  }

  if (video.error) {
    spinner.classList.remove('active');
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    video.addEventListener('canplay', () => {
      spinner.classList.remove('active');
      card.dataset.streamLoaded = '1';
      resolve(true);
    }, { once: true });
    video.addEventListener('error', () => {
      spinner.classList.remove('active');
      resolve(false);
    }, { once: true });
  });
}

// ── Prefetch ──────────────────────────────────────────────────────────────────

function prefetchAhead(card, count = 2) {
  let el = card.nextElementSibling;
  let remaining = count;
  while (el && remaining > 0) {
    if (el.classList.contains('short-card')) {
      const video = el.querySelector('.card-video');
      if (!video.src) {
        video.src   = `/api/proxy?v=${el.dataset.videoId}`;
        video.muted = state.globalMuted;
      }
      remaining--;
    }
    el = el.nextElementSibling;
  }
}

// ── Playback control ──────────────────────────────────────────────────────────

async function activateCard(card) {
  prefetchAhead(card);
  const ok = await loadStream(card);
  if (!ok) return;

  const video = card.querySelector('.card-video');

  video.muted = state.globalMuted;
  video.style.display = 'block';

  video.play().catch(() => {
    // Autoplay blocked — fall back to muted
    video.muted = true;
    video.play().catch(() => {});
  });
}

function deactivateCard(card) {
  card.querySelector('.card-video')?.pause();
}

function onCardClick(card) {
  const video     = card.querySelector('.card-video');
  const indicator = card.querySelector('.tap-indicator');
  const svgPath   = indicator.querySelector('svg path');

  if (!card.dataset.streamLoaded) return;

  if (video.paused) {
    video.play().catch(() => {});
    svgPath.setAttribute('d', 'M8 5v14l11-7z');
    indicator.classList.add('show');
    setTimeout(() => indicator.classList.remove('show'), 500);
  } else {
    video.pause();
    svgPath.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    indicator.classList.add('show');
  }
}

// ── Observers ─────────────────────────────────────────────────────────────────

const playObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) activateCard(entry.target);
    else                      deactivateCard(entry.target);
  });
}, { threshold: 0.6 });

const sentinelObserver = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting) fetchBatch();
}, { threshold: 0, root: document.getElementById('feed'), rootMargin: '0px 0px 300% 0px' });

// ── Mute ──────────────────────────────────────────────────────────────────────

function setGlobalMute(muted) {
  state.globalMuted = muted;
  document.querySelectorAll('.card-video').forEach(v => { v.muted = muted; });
  document.getElementById('mute-icon').style.display   = muted ? 'block' : 'none';
  document.getElementById('unmute-icon').style.display = muted ? 'none'  : 'block';
  document.getElementById('mute-btn').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

document.getElementById('mute-btn').addEventListener('click', () => setGlobalMute(!state.globalMuted));

// ── Keyboard nav ──────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  const feed = document.getElementById('feed');
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    feed.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
    hideNavHint();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    feed.scrollBy({ top: -window.innerHeight, behavior: 'smooth' });
    hideNavHint();
  } else if (e.key === ' ') {
    e.preventDefault();
    getActiveCard()?.dispatchEvent(new MouseEvent('click'));
  } else if (e.key === 'm') {
    setGlobalMute(!state.globalMuted);
  }
});

function getActiveCard() {
  const feed  = document.getElementById('feed');
  const st    = feed.scrollTop;
  let best = null, bestDist = Infinity;
  for (const card of feed.querySelectorAll('.short-card')) {
    const dist = Math.abs(card.offsetTop - st);
    if (dist < bestDist) { bestDist = dist; best = card; }
  }
  return best;
}

document.getElementById('feed').addEventListener('scroll', hideNavHint, { passive: true, once: true });
function hideNavHint() { document.getElementById('nav-hint')?.classList.add('hidden'); }

// ── Error states ──────────────────────────────────────────────────────────────

function showError() {
  document.getElementById('initial-loading').style.display = 'none';
  document.getElementById('error-screen').style.display   = 'flex';
}

function showNoServer() {
  document.getElementById('initial-loading').style.display = 'none';
  const err = document.getElementById('error-screen');
  err.querySelector('p').textContent = 'Run  node server.js  first, then open the printed URL.';
  err.style.display = 'flex';
}

document.getElementById('retry-btn').addEventListener('click', () => {
  location.reload();
});

// ── Location picker ───────────────────────────────────────────────────────────

function submitLocation(loc) {
  loc = loc.trim();
  if (!loc) return;
  state.location = loc;
  document.getElementById('location-picker').classList.add('hidden');
  document.getElementById('initial-loading').style.display = 'flex';
  document.querySelector('.header-title').textContent = loc;
  init();
}

document.getElementById('location-form').addEventListener('submit', e => {
  e.preventDefault();
  submitLocation(document.getElementById('location-input').value);
});

document.querySelectorAll('.lp-chip').forEach(chip => {
  chip.addEventListener('click', () => submitLocation(chip.dataset.loc));
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const feed     = document.getElementById('feed');
  const sentinel = document.createElement('div');
  sentinel.id    = 'sentinel';
  sentinel.innerHTML = '<div class="spinner"></div>';
  feed.appendChild(sentinel);
  sentinelObserver.observe(sentinel);

  await fetchBatch();
  document.getElementById('initial-loading').style.display = 'none';
}
