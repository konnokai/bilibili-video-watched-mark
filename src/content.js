(() => {
  const VIDEO_LINK_SELECTOR = 'a[href*="/video/BV"], a[href*="/video/bv"]';
  const PLAYER_SELECTOR = '.bpx-player-video-wrap video, #bilibili-player video';
  const SAVE_INTERVAL_MS = 5000;
  const summaries = new Map();
  const pendingScanRoots = new Set();
  let scanFrame = 0;
  let attachedVideo = null;
  let detachVideoListeners = null;
  let lastPeriodicSave = 0;

  function parseIdentity(value) {
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/i);
      if (!match) return null;
      const requestedPage = Number.parseInt(url.searchParams.get('p') || '1', 10);
      return {
        bvid: `BV${match[1].slice(2)}`,
        page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
      };
    } catch {
      return null;
    }
  }

  function getCurrentVideoIdentity() {
    const direct = parseIdentity(location.href);
    if (direct) return direct;

    const canonical = document.querySelector('link[rel="canonical"][href*="/video/"]');
    const identity = parseIdentity(canonical?.href || '');
    if (!identity) return null;

    const requestedPage = Number.parseInt(new URL(location.href).searchParams.get('p') || '1', 10);
    return {
      ...identity,
      page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    };
  }

  async function sendMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '擴充功能背景程序沒有回應');
    return response;
  }

  function renderProgress(link) {
    const identity = parseIdentity(link.href);
    if (!identity || !link.querySelector('img, picture')) return;

    const summary = summaries.get(identity.bvid);
    let bar = link.querySelector(':scope > .bvw-progress');
    if (!summary) {
      bar?.remove();
      link.classList.remove('bvw-progress-host');
      delete link.dataset.bvwBvid;
      return;
    }

    if (!bar) {
      bar = document.createElement('span');
      bar.className = 'bvw-progress';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'bvw-progress__fill';
      bar.append(fill);
      link.append(bar);
    }

    link.classList.add('bvw-progress-host');
    link.dataset.bvwBvid = identity.bvid;
    bar.classList.toggle('bvw-progress--completed', summary.completed);
    bar.style.setProperty('--bvw-progress', `${summary.ratio * 100}%`);
  }

  function scan(root) {
    if (!(root instanceof Document || root instanceof Element)) return;
    if (root instanceof Element && root.matches(VIDEO_LINK_SELECTOR)) renderProgress(root);
    root.querySelectorAll(VIDEO_LINK_SELECTOR).forEach(renderProgress);
  }

  function scheduleScan(root) {
    pendingScanRoots.add(root);
    if (scanFrame) return;

    scanFrame = requestAnimationFrame(() => {
      scanFrame = 0;
      for (const pendingRoot of pendingScanRoots) scan(pendingRoot);
      pendingScanRoots.clear();
    });
  }

  function refreshBvid(bvid) {
    document.querySelectorAll(VIDEO_LINK_SELECTOR).forEach((link) => {
      if (parseIdentity(link.href)?.bvid === bvid) renderProgress(link);
    });
  }

  async function saveVideoProgress(video, forceCompleted = false) {
    const identity = getCurrentVideoIdentity();
    if (!identity || video !== attachedVideo || !video.isConnected) return;

    const duration = Number(video.duration);
    const position = Number(video.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;

    const completed = forceCompleted || video.ended;
    if (!completed && position <= 0) return;

    try {
      const response = await sendMessage({
        type: 'SAVE_PROGRESS',
        record: {
          ...identity,
          position,
          duration,
          completed,
          updatedAt: Date.now(),
          source: 'player',
        },
      });
      summaries.set(identity.bvid, response.summary);
      refreshBvid(identity.bvid);
    } catch (error) {
      console.warn('[bvw] Failed to save playback progress', error);
    }
  }

  function attachToVideo(video) {
    if (video === attachedVideo) return;
    detachVideoListeners?.();
    attachedVideo = video;
    lastPeriodicSave = 0;

    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastPeriodicSave < SAVE_INTERVAL_MS) return;
      lastPeriodicSave = now;
      void saveVideoProgress(video);
    };
    const onPause = () => void saveVideoProgress(video);
    const onEnded = () => void saveVideoProgress(video, true);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    detachVideoListeners = () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }

  function detectPlayer() {
    if (!getCurrentVideoIdentity()) return;
    const candidates = [...document.querySelectorAll(PLAYER_SELECTOR)];
    const video = candidates.find((item) => item.isConnected && item.readyState > 0)
      || candidates.find((item) => item.isConnected);
    if (video) attachToVideo(video);
  }

  async function initialize() {
    try {
      const response = await sendMessage({ type: 'GET_PROGRESS_SUMMARIES' });
      for (const [bvid, summary] of Object.entries(response.summaries)) {
        summaries.set(bvid, summary);
      }
    } catch (error) {
      console.warn('[bvw] Failed to load saved progress', error);
    }

    scan(document);
    detectPlayer();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          scheduleScan(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) scheduleScan(node);
        });
      }
      detectPlayer();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    window.addEventListener('pagehide', () => {
      if (attachedVideo) void saveVideoProgress(attachedVideo);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && attachedVideo) void saveVideoProgress(attachedVideo);
    });
  }

  void initialize();
})();
