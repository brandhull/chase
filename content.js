(() => {
  'use strict';

  const FOLDER_SVG = '<svg style="display:inline-block;width:.9em;height:.8em;vertical-align:-.1em" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5H17.5A1.5 1.5 0 0 1 19 7.5v6A1.5 1.5 0 0 1 17.5 15h-15A1.5 1.5 0 0 1 1 13.5V5z"/></svg>';

  // Silently drop "Extension context invalidated" errors that fire when the
  // extension is reloaded while this content script is still running.
  window.addEventListener('unhandledrejection', e => {
    const msg = e.reason?.message ?? '';
    if (msg.includes('Extension context invalidated') ||
        msg.includes("reading 'local'") ||
        msg.includes("reading 'storage'")) {
      e.preventDefault();
    }
  });

  const BTN_ID   = 'yt-organizer-btn';
  const PICKER_ID = 'yt-organizer-picker';

  // ── Page detection ──────────────────────────────────────────────────────────

  function getPageType() {
    const { pathname } = location;
    if (pathname === '/watch') return 'video';
    if (/^\/(channel\/|@|c\/)/.test(pathname)) return 'channel';
    return null;
  }

  // ── Channel extraction ───────────────────────────────────────────────────────

  function parseChannelUrl(url) {
    if (!url) return null;
    const clean = url.split('?')[0].replace(/\/$/, '');
    let id = '', handle = '';
    const h = clean.match(/\/@([^/]+)/);
    if (h) { handle = `@${h[1]}`; id = handle; }
    const uc = clean.match(/\/channel\/(UC[^/]+)/);
    if (uc) id = uc[1];
    const c = clean.match(/\/c\/([^/]+)/);
    if (c && !id) id = `c:${c[1]}`;
    if (!id) id = clean;
    return { id, handle, url: clean };
  }

  function extractFromVideoPage() {
    const owner = document.querySelector('ytd-video-owner-renderer');
    if (!owner) return null;

    const link = owner.querySelector('a#avatar-link') ||
                 owner.querySelector('a.ytd-channel-name') ||
                 owner.querySelector('ytd-channel-name a');
    if (!link?.href) return null;

    const nameEl = owner.querySelector('ytd-channel-name yt-formatted-string') ||
                   owner.querySelector('#channel-name yt-formatted-string') ||
                   owner.querySelector('#channel-name a');
    const name = nameEl?.textContent?.trim() || link.textContent?.trim() || '';

    const avatarEl = owner.querySelector('#avatar img, #channel-icon img');
    const thumbnail = avatarEl?.src || '';

    const parsed = parseChannelUrl(link.href);
    if (!parsed) return null;
    return { ...parsed, name, thumbnail };
  }

  function extractFromChannelPage() {
    const url = location.href;
    const parsed = parseChannelUrl(url);
    if (!parsed) return null;

    const nameSelectors = [
      'ytd-channel-header-renderer #channel-name yt-formatted-string',
      'ytd-c4-tabbed-header-renderer #channel-name yt-formatted-string',
      '#channel-name yt-formatted-string',
      'yt-dynamic-sizing-formatted-string',
    ];
    let name = '';
    for (const sel of nameSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
    }
    // No document.title fallback — it can be stale from a previous SPA page visit.

    const avatarEl = document.querySelector(
      'ytd-channel-header-renderer #avatar img, ytd-c4-tabbed-header-renderer #avatar img'
    );
    const thumbnail = avatarEl?.src || '';

    return { ...parsed, name, thumbnail };
  }

  function extractChannelInfo() {
    const type = getPageType();
    if (type === 'video')   return extractFromVideoPage();
    if (type === 'channel') return extractFromChannelPage();
    return null;
  }

  // ── Wait for an element to appear ────────────────────────────────────────────

  function waitForElement(selectors, timeout = 8000) {
    if (!Array.isArray(selectors)) selectors = [selectors];
    return new Promise((resolve, reject) => {
      const check = () => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return resolve(el);
        }
        return null;
      };
      const found = check();
      if (found) return;

      const observer = new MutationObserver(() => {
        const el = check();
        if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timeout waiting for element'));
      }, timeout);
    });
  }

  // ── Storage helpers ───────────────────────────────────────────────────────────

  // Wraps chrome.storage.local.get so stale-context errors (after extension
  // reload without page reload) are caught silently and return the defaults.
  function storageGet(defaults) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(defaults, resolve);
      } catch { resolve(defaults); }
    });
  }

  // Wraps chrome.runtime.sendMessage — silently drops calls on stale context.
  function safeSendMessage(msg) {
    try { chrome.runtime.sendMessage(msg); } catch { /* stale context */ }
  }

  async function buildChannelFolderMap() {
    const { folders, channels } = await storageGet({ folders: [], channels: [] });
    const folderNames = new Map(folders.map(f => [f.id, f.name]));
    const map = new Map();
    channels.forEach(ch => {
      if (!map.has(ch.id)) map.set(ch.id, []);
      const name = folderNames.get(ch.folderId);
      if (name) map.get(ch.id).push(name);
    });
    return map;
  }

  // ── Main button state ─────────────────────────────────────────────────────────

  function applyButtonState(btn, names) {
    if (names.length === 0) {
      btn.innerHTML = `<span>${FOLDER_SVG}</span> Save to folder`;
      btn.classList.remove('yto-btn-saved');
      btn.removeAttribute('title');
    } else if (names.length === 1) {
      btn.innerHTML = `<span>${FOLDER_SVG}</span> ${names[0]}`;
      btn.classList.add('yto-btn-saved');
      btn.title = `In: ${names[0]} — click to add to another`;
    } else {
      btn.innerHTML = `<span>${FOLDER_SVG}</span> ${names.length} folders`;
      btn.classList.add('yto-btn-saved');
      btn.title = `In: ${names.join(', ')}`;
    }
  }

  async function refreshMainButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const info = extractChannelInfo();
    if (!info) return;
    const map = await buildChannelFolderMap();
    applyButtonState(btn, map.get(info.id) || []);
  }

  // Called after any channel save to update both the button and the sidebar badge
  async function notifyChannelSaved(channelId) {
    const map = await buildChannelFolderMap();
    const names = map.get(channelId) || [];
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      const info = extractChannelInfo();
      if (info?.id === channelId) applyButtonState(btn, names);
    }
  }

  // ── Folder picker UI ─────────────────────────────────────────────────────────

  function closePicker() {
    document.getElementById(PICKER_ID)?.remove();
  }

  async function showPicker(anchorEl, channelInfo) {
    closePicker();

    const { folders, channels } = await storageGet({ folders: [], channels: [] });

    const picker = document.createElement('div');
    picker.id = PICKER_ID;

    const channelFolderIds = new Set(
      channels.filter(c => c.id === channelInfo.id).map(c => c.folderId)
    );

    const header = document.createElement('div');
    header.className = 'yto-picker-header';
    header.textContent = 'Save to folder';
    picker.appendChild(header);

    if (folders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'yto-picker-empty';
      empty.textContent = 'No folders yet.';
      picker.appendChild(empty);
    } else {
      folders.forEach(folder => {
        const inFolder = channelFolderIds.has(folder.id);

        const row = document.createElement('div');
        row.className = 'yto-picker-row-item';

        const item = document.createElement('button');
        item.className = 'yto-picker-item';
        item.innerHTML = `<span class="yto-picker-check">${inFolder ? '✓' : ''}</span>${folder.name}`;
        item.disabled = inFolder;
        item.addEventListener('click', async () => {
          await addChannel(channelInfo, folder, item);
        });
        row.appendChild(item);

        if (inFolder) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'yto-picker-remove-btn';
          removeBtn.title = `Remove from "${folder.name}"`;
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', async () => {
            await removeChannel(channelInfo, folder, row);
          });
          row.appendChild(removeBtn);
        }

        picker.appendChild(row);
      });
    }

    const divider = document.createElement('div');
    divider.className = 'yto-picker-divider';
    picker.appendChild(divider);

    const newBtn = document.createElement('button');
    newBtn.className = 'yto-picker-item yto-picker-new';
    newBtn.textContent = '+ New folder…';
    newBtn.addEventListener('click', () => showNewFolderInput(picker, channelInfo));
    picker.appendChild(newBtn);

    const manageBtn = document.createElement('button');
    manageBtn.className = 'yto-picker-item yto-picker-manage';
    manageBtn.textContent = '⚙ Manage folders';
    manageBtn.addEventListener('click', () => {
      safeSendMessage({ type: 'openOptions' });
      closePicker();
    });
    picker.appendChild(manageBtn);

    // Position below anchor
    document.body.appendChild(picker);
    const rect = anchorEl.getBoundingClientRect();
    picker.style.top  = `${rect.bottom + window.scrollY + 6}px`;
    picker.style.left = `${rect.left  + window.scrollX}px`;

    // Close on outside click
    const outsideHandler = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorEl) {
        closePicker();
        document.removeEventListener('click', outsideHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);
  }

  async function addChannel(channelInfo, folder, itemEl) {
    const result = await new Promise(async resolve => {
      const { channels } = await storageGet({ channels: [] });
      if (channels.find(c => c.id === channelInfo.id && c.folderId === folder.id)) {
        return resolve({ alreadyExists: true });
      }
      channels.push({ ...channelInfo, folderId: folder.id, addedAt: Date.now() });
      chrome.storage.local.set({ channels }, () => resolve({ added: true }));
    });

    if (result.alreadyExists) {
      showToast(`Already in "${folder.name}"`);
    } else {
      showToast(`Saved to "${folder.name}"`);
      if (itemEl) {
        itemEl.querySelector('.yto-picker-check').textContent = '✓';
        itemEl.disabled = true;
      }
      notifyChannelSaved(channelInfo.id);
    }
    closePicker();
  }

  async function removeChannel(channelInfo, folder, rowEl) {
    await new Promise(resolve => {
      chrome.storage.local.get({ channels: [] }, ({ channels }) => {
        const next = channels.filter(c => !(c.id === channelInfo.id && c.folderId === folder.id));
        chrome.storage.local.set({ channels: next }, resolve);
      });
    });

    showToast(`Removed from "${folder.name}"`);
    if (rowEl) {
      const item = rowEl.querySelector('.yto-picker-item');
      if (item) {
        item.querySelector('.yto-picker-check').textContent = '';
        item.disabled = false;
      }
      rowEl.querySelector('.yto-picker-remove-btn')?.remove();
    }
    notifyChannelSaved(channelInfo.id);
    closePicker();
  }

  function showNewFolderInput(picker, channelInfo) {
    picker.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'yto-picker-header';
    header.textContent = 'New folder name';
    picker.appendChild(header);

    const input = document.createElement('input');
    input.className = 'yto-picker-input';
    input.type = 'text';
    input.placeholder = 'Folder name…';
    picker.appendChild(input);

    const row = document.createElement('div');
    row.className = 'yto-picker-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'yto-picker-btn yto-picker-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closePicker);

    const createBtn = document.createElement('button');
    createBtn.className = 'yto-picker-btn yto-picker-btn-create';
    createBtn.textContent = 'Create & Save';
    createBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const { folders } = await storageGet({ folders: [] });
      const folder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
      folders.push(folder);
      await new Promise(r => chrome.storage.local.set({ folders }, r));
      await addChannel(channelInfo, folder, null);
    });

    row.appendChild(cancelBtn);
    row.appendChild(createBtn);
    picker.appendChild(row);
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createBtn.click();
      if (e.key === 'Escape') closePicker();
    });
  }

  // ── Toast notification ───────────────────────────────────────────────────────

  function showToast(msg) {
    document.getElementById('yto-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'yto-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('yto-toast-show'), 10);
    setTimeout(() => { toast.classList.remove('yto-toast-show'); setTimeout(() => toast.remove(), 300); }, 2500);
  }

  // ── Button injection ─────────────────────────────────────────────────────────

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerHTML = `<span>${FOLDER_SVG}</span> Save to folder`;
    return btn;
  }

  async function injectButton() {
    if (document.getElementById(BTN_ID)) return;

    const type = getPageType();
    if (!type) return;

    let anchorEl = null;

    if (type === 'video') {
      try {
        anchorEl = await waitForElement([
          'ytd-video-owner-renderer ytd-subscribe-button-renderer',
          'ytd-video-owner-renderer #subscribe-button',
          'ytd-video-owner-renderer',
        ], 6000);
      } catch { return; }

      const owner = document.querySelector('ytd-video-owner-renderer');
      if (!owner || document.getElementById(BTN_ID)) return;

      const btn = createButton();
      // Insert after subscribe button (or at end of owner)
      const sub = owner.querySelector('ytd-subscribe-button-renderer, #subscribe-button');
      if (sub) sub.after(btn);
      else owner.appendChild(btn);

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const info = extractChannelInfo();
        if (info) showPicker(btn, info);
        else showToast('Could not detect channel');
      });
      refreshMainButton();

    } else if (type === 'channel') {
      // Wait for the header, then wait specifically for the subscribe button area
      let header = null;
      try {
        header = await waitForElement([
          'ytd-c4-tabbed-header-renderer',
          'ytd-channel-header-renderer',
          'yt-page-header-renderer',
        ], 8000);
      } catch { return; }

      // Also wait for the subscribe button container specifically (gives it up to 5s beyond header)
      try {
        await waitForElement([
          '.ytSubscribeButtonViewModelContainer',
          'ytd-subscribe-button-renderer',
          '#subscribe-button',
          '#buttons',
        ], 5000);
      } catch { /* proceed anyway and try our best */ }

      if (document.getElementById(BTN_ID)) return;

      const btn = createButton();
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const info = extractChannelInfo();
        if (info) showPicker(btn, info);
        else showToast('Could not detect channel');
      });

      // Search header first, fall back to full document so shadow-DOM quirks don't block us
      const find = sel => header.querySelector(sel) ?? document.querySelector(sel);
      const tryAppend = sel => { const el = find(sel); if (el) { el.appendChild(btn); return true; } return false; };

      // Anchor off the subscribe element to find the right row, then insert after the
      // last sibling in that row. This handles Subscribe-only, Subscribe+Join,
      // Subscribe+Join+Community without touching tab navigation buttons.
      function tryAfterLastActionButton() {
        // Use the outermost subscribe wrapper — it should be a direct sibling of Join/Community.
        const subWrapper =
          find('yt-subscription-notification-toggle-button-renderer-next') ||
          find('ytd-subscribe-button-renderer');

        if (subWrapper) {
          const parent = subWrapper.parentElement;
          const last = parent?.lastElementChild;
          if (last && last !== btn) { last.after(btn); return true; }
          subWrapper.after(btn);
          return true;
        }

        // Fallback: inner subscribe container
        const subContainer = find('.ytSubscribeButtonViewModelContainer');
        if (subContainer) {
          const parent = subContainer.parentElement;
          const last = parent?.lastElementChild;
          if (last && last !== btn) { last.after(btn); return true; }
          subContainer.after(btn);
          return true;
        }

        return false;
      }

      const placed = (
        tryAppend('yt-flexible-actions-view-model') ||
        tryAfterLastActionButton() ||
        tryAppend('#buttons') ||
        tryAppend('.yt-flexible-actions-view-model-wiz__action-row') ||
        tryAppend('.yt-page-header-view-model-wiz__actions') ||
        tryAppend('#channel-header-container') ||
        (() => { header.appendChild(btn); return true; })()
      );

      if (placed) refreshMainButton();
    }
  }

  // ── Home feed folder filter ───────────────────────────────────────────────────

  const CHIPS_ID = 'yto-folder-chips';
  const LATEST_GRID_ID = 'yto-latest-grid';
  let activeFolderId = null;
  let todayOnly = false;
  let feedFilterObserver = null;
  let chipsInjecting = false;   // prevents concurrent injectFolderChips runs
  let chipReinjectTimer = null; // debounce timer for the home-page observer

  async function injectFolderChips() {
    if (location.pathname !== '/') return;
    if (document.getElementById(CHIPS_ID)) return;
    if (chipsInjecting) return;
    chipsInjecting = true;
    try {
      // Wait for YouTube's chip bar or the grid renderer — whichever appears first.
      try {
        await waitForElement([
          'ytd-feed-filter-chip-bar-renderer',
          'yt-chip-cloud-renderer',
          'ytd-rich-grid-renderer',
        ], 12000);
      } catch { return; }

      const { folders } = await storageGet({ folders: [] });
      if (folders.length === 0) return;
      if (document.getElementById(CHIPS_ID)) return; // guard against race
      if (location.pathname !== '/') return;          // left home while waiting

      const bar = document.createElement('div');
      bar.id = CHIPS_ID;

      const scrollArea = document.createElement('div');
      scrollArea.className = 'yto-chips-scroll';
      scrollArea.appendChild(makeChip('All', null, true));
      folders.forEach(f => scrollArea.appendChild(makeChip(f.name, f.id, false)));
      bar.appendChild(scrollArea);
      bar.appendChild(makeTodayBtn());

      // Insert after YouTube's native chip bar (inside the grid) so our chips stay visible.
      const ytChipBar = document.querySelector('ytd-feed-filter-chip-bar-renderer, yt-chip-cloud-renderer');
      const grid = document.querySelector('ytd-rich-grid-renderer');
      if (ytChipBar)    ytChipBar.after(bar);
      else if (grid)    grid.before(bar);
      else document.querySelector('ytd-two-column-browse-results-renderer, ytd-browse')?.prepend(bar);
    } finally {
      chipsInjecting = false;
    }
  }

  const CALENDAR_SVG      = `<svg viewBox="0 0 20 18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="3" width="17" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M6 1v4M14 1v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M1.5 8h17" stroke="currentColor" stroke-width="1.5"/></svg>`;
  const CALENDAR_PLUS_SVG = `<svg viewBox="0 0 23 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 2v4M10 2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M1 9h14" stroke="currentColor" stroke-width="1.5"/><circle cx="19" cy="6" r="4" fill="currentColor"/><path d="M19 4v4M17 6h4" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  function makeTodayBtn() {
    const btn = document.createElement('button');
    btn.className = 'yto-today-btn';
    btn.title = 'Show today only';
    btn.innerHTML = CALENDAR_SVG;
    btn.addEventListener('click', () => {
      todayOnly = !todayOnly;
      btn.classList.toggle('yto-today-active', todayOnly);
      btn.innerHTML = todayOnly ? CALENDAR_PLUS_SVG : CALENDAR_SVG;
      if (activeFolderId !== null) {
        applyFeedFilter();
      } else if (todayOnly) {
        showToast('Select a folder to filter by today');
      }
    });
    return btn;
  }

  function makeChip(label, folderId, active) {
    const btn = document.createElement('button');
    btn.className = 'yto-chip' + (active ? ' yto-chip-active' : '');
    btn.textContent = label;
    if (folderId) btn.dataset.folderId = folderId;
    btn.addEventListener('click', () => {
      activeFolderId = folderId;
      document.querySelectorAll(`#${CHIPS_ID} .yto-chip`).forEach(c => {
        c.classList.toggle('yto-chip-active',
          folderId === null ? !c.dataset.folderId : c.dataset.folderId === folderId
        );
      });
      applyFeedFilter();
    });
    return btn;
  }

  // ── Latest-video fetching ─────────────────────────────────────────────────────

  // Convert an ISO date string to a human-friendly relative label.
  function relativeTime(date) {
    const days = Math.floor((Date.now() - date) / 86400000);
    if (days <= 0)  return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 7)   return `${days} days ago`;
    if (days < 14)  return '1 week ago';
    if (days < 30)  return `${Math.floor(days / 7)} weeks ago`;
    if (days < 60)  return '1 month ago';
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    if (days < 730) return '1 year ago';
    return `${Math.floor(days / 365)} years ago`;
  }

  function isToday(isoDate) {
    if (!isoDate) return false;
    const d = new Date(isoDate);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }

  function decodeXml(str) {
    return (str || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
  }

  async function fetchLatestVideo(channel) {
    try {
      // ── Step 1: resolve UCxxx channel ID ────────────────────────────────
      // Needed for the RSS feed. If the channel was saved from a /channel/UC…
      // URL we already have it; otherwise fetch the /videos page and extract it.
      let channelId = channel.id?.startsWith('UC') ? channel.id : '';
      let html = null;

      if (!channelId) {
        const res = await fetch(channel.url.replace(/\/$/, '') + '/videos');
        if (!res.ok) return null;
        html = await res.text();
        // Use the RSS <link> tag in the page <head> — always the current channel's own ID,
        // never a recommendation or sidebar channel.
        const m = html.match(/feeds\/videos\.xml\?channel_id=(UC[\w-]+)/);
        if (m) channelId = m[1];
      }

      // ── Step 2: fetch RSS feed (reliable title + date) ───────────────────
      if (channelId) {
        try {
          const rssRes = await fetch(
            `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
          );
          if (rssRes.ok) {
            const xml = await rssRes.text();
            // Iterate entries (newest first) and skip Shorts
            const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
            let entry = '';
            for (const e of entries) {
              const link = e.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
              if (!link.includes('/shorts/')) { entry = e; break; }
            }
            if (!entry) entry = entries[0] ?? ''; // fallback: all were Shorts
            const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] ?? '';
            if (videoId) {
              const title = decodeXml(entry.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
              const pubIso = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? '';
              const publishedTime = pubIso ? relativeTime(new Date(pubIso)) : '';
              // Use the RSS feed's own <author><name> — always accurate, fixes
              // channels that were saved with the wrong name due to SPA timing.
              const rssName = decodeXml(xml.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1] ?? '');
              return {
                videoId, title,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                channelName: rssName || channel.name,
                channelUrl:  channel.url,
                channelThumbnail: channel.thumbnail,
                publishedTime,
                publishedIso: pubIso,
                viewCount: '', duration: '',
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
              };
            }
          }
        } catch { /* fall through to HTML parse */ }
      }

      // ── Step 3: fallback — parse videoId from HTML ────────────────────
      if (!html) {
        const res = await fetch(channel.url.replace(/\/$/, '') + '/videos');
        if (!res.ok) return null;
        html = await res.text();
      }
      const videoId = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/)?.[1] ?? '';
      if (!videoId) return null;

      return {
        videoId, title: '', publishedTime: '', publishedIso: '', viewCount: '', duration: '',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        channelName: channel.name, channelUrl: channel.url,
        channelThumbnail: channel.thumbnail,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
      };
    } catch (err) {
      console.error('[YTO] fetchLatestVideo threw for', channel.name, err);
      return null;
    }
  }


  function escHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderVideoCard(v) {
    const card = document.createElement('div');
    card.className = 'yto-video-card';
    const avatarHtml = v.channelThumbnail
      ? `<a href="${escHtml(v.channelUrl)}" class="yto-card-avatar-wrap"><img class="yto-card-avatar" src="${escHtml(v.channelThumbnail)}" alt="" loading="lazy"></a>`
      : '';
    const statsHtml = [v.viewCount, v.publishedTime].filter(Boolean).join(' · ');
    card.innerHTML = `
      <a class="yto-card-thumb-wrap" href="${escHtml(v.watchUrl)}">
        <img class="yto-card-thumb" src="${escHtml(v.thumbnail)}" alt="" loading="lazy">
        ${v.duration ? `<span class="yto-card-duration">${escHtml(v.duration)}</span>` : ''}
      </a>
      <div class="yto-card-body">
        ${avatarHtml}
        <div class="yto-card-info">
          <a class="yto-card-title" href="${escHtml(v.watchUrl)}">${escHtml(v.title)}</a>
          <a class="yto-card-channel" href="${escHtml(v.channelUrl)}">${escHtml(v.channelName)}</a>
          ${statsHtml ? `<div class="yto-card-stats">${escHtml(statsHtml)}</div>` : ''}
        </div>
      </div>
    `;
    return card;
  }

  function getOrCreateLatestGrid() {
    let el = document.getElementById(LATEST_GRID_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = LATEST_GRID_ID;
      // Insert immediately after our folder chips — everything stays inside #contents
      // so we never hide that container (which would hide our chips too).
      const chips = document.getElementById(CHIPS_ID);
      if (chips) {
        chips.after(el);
      } else {
        const ytChipBar = document.querySelector('ytd-feed-filter-chip-bar-renderer, yt-chip-cloud-renderer');
        if (ytChipBar) ytChipBar.after(el);
        else document.querySelector('ytd-rich-grid-renderer')?.prepend(el);
      }
    }
    return el;
  }

  // Hide native feed items via a <style> tag so the rule automatically applies
  // to rows added later by YouTube's infinite scroll — no observer needed.
  const HIDE_STYLE_ID = 'yto-hide-native';
  function hideNativeItems() {
    if (document.getElementById(HIDE_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = HIDE_STYLE_ID;
    s.textContent = 'ytd-rich-item-renderer, ytd-rich-grid-row, ytd-rich-section-renderer { display: none !important; }';
    document.head.appendChild(s);
  }
  function restoreNativeItems() {
    document.getElementById(HIDE_STYLE_ID)?.remove();
  }

  async function applyFeedFilter() {
    if (activeFolderId === null) {
      document.getElementById(LATEST_GRID_ID)?.remove();
      restoreNativeItems();
      return;
    }

    const { channels } = await storageGet({ channels: [] });
    const folderChannels = channels.filter(c => c.folderId === activeFolderId);

    hideNativeItems();

    const latestGrid = getOrCreateLatestGrid();
    latestGrid.innerHTML = '<div class="yto-grid-status">Loading latest videos…</div>';

    if (folderChannels.length === 0) {
      latestGrid.innerHTML = '<div class="yto-grid-status">This folder has no channels yet.</div>';
      return;
    }

    const snapshotFolderId = activeFolderId;
    const videos = (await Promise.all(folderChannels.map(ch => fetchLatestVideo(ch)))).filter(Boolean);

    if (activeFolderId !== snapshotFolderId) return; // user switched chip while loading

    const filtered = todayOnly ? videos.filter(v => isToday(v.publishedIso)) : videos;
    latestGrid.innerHTML = '';
    if (filtered.length === 0) {
      latestGrid.innerHTML = `<div class="yto-grid-status">${todayOnly ? 'No videos published today.' : 'No videos found.'}</div>`;
      return;
    }
    filtered.forEach(v => latestGrid.appendChild(renderVideoCard(v)));
  }

  function clearFolderFilter() {
    feedFilterObserver?.disconnect();
    feedFilterObserver = null;
    activeFolderId = null;
    todayOnly = false;
    document.getElementById(CHIPS_ID)?.remove();
    document.getElementById(LATEST_GRID_ID)?.remove();
    restoreNativeItems();
  }

  // ── Subscription sidebar badges ───────────────────────────────────────────────

  // ── Subscription link → /videos redirect ─────────────────────────────────────

  // Matches channel-root URLs: /@handle or /channel/UCxxx (no sub-path after)
  const CHANNEL_ROOT_RE = /youtube\.com\/(channel\/UC[\w-]+|@[\w.-]+)\/?$/;

  function rewriteSubscriptionLinks() {
    // Don't rely on section title selectors — just match channel-root hrefs in any guide entry.
    // This naturally covers subscription channels; non-channel entries (history, playlists…)
    // have different URL shapes and won't match.
    document.querySelectorAll('ytd-guide-entry-renderer a:not([data-yto-videos])').forEach(link => {
      if (!link.href || !CHANNEL_ROOT_RE.test(link.href)) return;
      link.setAttribute('data-yto-videos', '1');
      // Capture phase fires before YouTube's SPA router so preventDefault works
      link.addEventListener('click', (e) => {
        const clean = link.href.split('?')[0].replace(/\/$/, '');
        if (CHANNEL_ROOT_RE.test(clean)) {
          e.preventDefault();
          e.stopPropagation();
          window.location.href = `${clean}/videos`;
        }
      }, { capture: true });
    });
  }

  function injectSubscriptionBadges() {
    // Badges removed — folder state is shown on the channel page button instead.
    // Still run the /videos redirect rewrite on each call.
    rewriteSubscriptionLinks();
  }

  // ── Sidebar "Folders" link ────────────────────────────────────────────────────

  const SIDEBAR_ID = 'yto-sidebar-link';

  function injectSidebarLink() {
    if (document.getElementById(SIDEBAR_ID)) return;

    // Find the "Playlists" guide entry by text, then insert after it
    const entries = document.querySelectorAll('ytd-guide-entry-renderer');
    let insertAfter = null;
    for (const entry of entries) {
      const text = entry.textContent?.trim() ?? '';
      if (text === 'Playlists' || text.startsWith('Playlists')) {
        insertAfter = entry;
        break;
      }
    }
    if (!insertAfter) return;

    const wrapper = document.createElement('div');
    wrapper.id = SIDEBAR_ID;

    const anchor = document.createElement('a');
    anchor.className = 'yto-sidebar-anchor';
    anchor.href = chrome.runtime.getURL('options.html');
    anchor.target = '_blank';
    anchor.innerHTML = `<span class="yto-sidebar-icon"><svg class="yto-folder-icon" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5H17.5A1.5 1.5 0 0 1 19 7.5v6A1.5 1.5 0 0 1 17.5 15h-15A1.5 1.5 0 0 1 1 13.5V5z"/></svg></span><span class="yto-sidebar-label">Folders</span>`;
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {
        window.open(chrome.runtime.getURL('options.html'), '_blank');
      });
    }, { capture: true });

    wrapper.appendChild(anchor);
    insertAfter.after(wrapper);
  }

  // ── Notes panel (watch pages) ────────────────────────────────────────────

  const NOTES_PANEL_ID = 'yto-notes-panel';

  function getCurrentVideoId() {
    return new URLSearchParams(location.search).get('v') || null;
  }

  function getVideoMeta() {
    const videoId = getCurrentVideoId();
    if (!videoId) return null;
    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata h1 yt-formatted-string'
    );
    const videoTitle = titleEl?.textContent?.trim() || '';
    const ownerEl = document.querySelector('ytd-video-owner-renderer');
    const channelLink = ownerEl?.querySelector('a#avatar-link, a.ytd-channel-name, ytd-channel-name a');
    const channelNameEl = ownerEl?.querySelector('ytd-channel-name yt-formatted-string, #channel-name yt-formatted-string');
    const channelName = channelNameEl?.textContent?.trim() || '';
    const channelId = channelLink ? (parseChannelUrl(channelLink.href)?.id || '') : '';
    return { videoId, videoTitle, channelName, channelId };
  }

  async function baserowFetch(method, path, body) {
    const { baserowToken } = await storageGet({ baserowToken: '' });
    if (!baserowToken) throw new Error('no-token');
    const opts = {
      method,
      headers: { 'Authorization': `Token ${baserowToken}`, 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`https://api.baserow.io${path}`, opts);
    if (!res.ok && res.status !== 204) throw new Error(`Baserow ${res.status}`);
    if (res.status === 204) return null;
    return res.json();
  }

  async function fetchNotes(videoId) {
    const { baserowNotesTableId } = await storageGet({ baserowNotesTableId: '1128487' });
    const filter = encodeURIComponent(JSON.stringify({
      filter_type: 'AND',
      filters: [{ type: 'equal', field: 'video_id', value: videoId }],
    }));
    const data = await baserowFetch('GET',
      `/api/database/rows/table/${baserowNotesTableId}/?user_field_names=true&filters=${filter}&order_by=created_at`
    );
    return data?.results ?? [];
  }

  async function saveNote(videoId, noteText, sendToSeneca) {
    const meta = getVideoMeta();
    const { baserowNotesTableId, baserowSenecaTableId } = await storageGet({
      baserowNotesTableId: '1128487', baserowSenecaTableId: '1116959',
    });
    const row = await baserowFetch('POST',
      `/api/database/rows/table/${baserowNotesTableId}/?user_field_names=true`,
      {
        video_id: videoId,
        video_url: `https://www.youtube.com/watch?v=${videoId}`,
        video_title: meta?.videoTitle ?? '',
        channel_name: meta?.channelName ?? '',
        channel_id: meta?.channelId ?? '',
        note: noteText.trim(),
        created_at: new Date().toISOString(),
      }
    );
    if (sendToSeneca) {
      await baserowFetch('POST',
        `/api/database/rows/table/${baserowSenecaTableId}/?user_field_names=true`,
        { 'My Comments': noteText.trim(), 'Author': meta?.channelName ?? '' }
      );
    }
    return row;
  }

  async function deleteNote(rowId) {
    const { baserowNotesTableId } = await storageGet({ baserowNotesTableId: '1128487' });
    await baserowFetch('DELETE', `/api/database/rows/table/${baserowNotesTableId}/${rowId}/`);
  }

  function renderNotesList(notes, listEl) {
    listEl.innerHTML = '';
    if (notes.length === 0) {
      listEl.innerHTML = '<div class="yto-notes-empty">No notes yet.</div>';
      return;
    }
    notes.forEach(n => {
      const item = document.createElement('div');
      item.className = 'yto-note-item';
      const dateStr = n.created_at ? new Date(n.created_at).toLocaleDateString() : '';
      item.innerHTML = `
        <div class="yto-note-text">${escHtml(n.note)}</div>
        <div class="yto-note-meta">
          <span class="yto-note-date">${escHtml(dateStr)}</span>
          <button class="yto-note-delete" data-id="${n.id}" title="Delete">✕</button>
        </div>
      `;
      item.querySelector('.yto-note-delete').addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        try {
          await deleteNote(id);
          item.remove();
          if (!listEl.querySelector('.yto-note-item')) {
            listEl.innerHTML = '<div class="yto-notes-empty">No notes yet.</div>';
          }
        } catch { showToast('Failed to delete note'); }
      });
      listEl.appendChild(item);
    });
  }

  async function injectNotesPanel() {
    if (getPageType() !== 'video') return;
    if (document.getElementById(NOTES_PANEL_ID)) return;
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    let secondary;
    try {
      secondary = await waitForElement(
        ['#secondary-inner', '#secondary', 'ytd-watch-next-secondary-results-renderer'], 8000
      );
    } catch { return; }

    if (document.getElementById(NOTES_PANEL_ID)) return;

    const panel = document.createElement('div');
    panel.id = NOTES_PANEL_ID;
    panel.innerHTML = `
      <div class="yto-np-header">
        <span class="yto-np-title">Notes</span>
        <button class="yto-np-copy-btn" title="Copy all notes">Copy</button>
        <button class="yto-np-toggle" title="Collapse">−</button>
      </div>
      <div class="yto-np-body">
        <div class="yto-np-list"><div class="yto-notes-empty">Loading…</div></div>
        <div class="yto-np-compose">
          <textarea class="yto-np-textarea" placeholder="Add a note… (⌘↵ to save)" rows="3"></textarea>
          <div class="yto-np-compose-row">
            <label class="yto-np-seneca-label">
              <input type="checkbox"> Seneca
            </label>
            <button class="yto-np-save-btn">Save</button>
          </div>
        </div>
      </div>
    `;

    secondary.prepend(panel);

    const listEl = panel.querySelector('.yto-np-list');
    const body = panel.querySelector('.yto-np-body');
    const toggleBtn = panel.querySelector('.yto-np-toggle');
    const textarea = panel.querySelector('.yto-np-textarea');
    const senecaCheckbox = panel.querySelector('input[type=checkbox]');
    const saveBtn = panel.querySelector('.yto-np-save-btn');

    // Load notes
    try {
      const { baserowToken } = await storageGet({ baserowToken: '' });
      if (!baserowToken) {
        listEl.innerHTML = '<div class="yto-notes-empty">Add a Baserow token in <a href="#" class="yto-settings-link">settings</a>.</div>';
        listEl.querySelector('.yto-settings-link')?.addEventListener('click', (e) => {
          e.preventDefault();
          safeSendMessage({ type: 'openOptions' });
        });
      } else {
        renderNotesList(await fetchNotes(videoId), listEl);
      }
    } catch {
      listEl.innerHTML = '<div class="yto-notes-empty">Failed to load notes.</div>';
    }

    // Copy all notes
    const copyBtn = panel.querySelector('.yto-np-copy-btn');
    copyBtn.addEventListener('click', async () => {
      const items = [...listEl.querySelectorAll('.yto-note-item')];
      if (items.length === 0) { showToast('No notes to copy'); return; }
      const meta = getVideoMeta();
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const title = meta?.videoTitle ? `${meta.videoTitle}\n${url}` : url;
      const noteLines = items.map(el => el.querySelector('.yto-note-text')?.textContent?.trim()).filter(Boolean).join('\n\n');
      await navigator.clipboard.writeText(`${title}\n\n${noteLines}`);
      showToast('Copied to clipboard');
    });

    // Toggle collapse
    let collapsed = false;
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      toggleBtn.textContent = collapsed ? '+' : '−';
    });

    // Save
    async function doSave() {
      const text = textarea.value.trim();
      if (!text) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await saveNote(videoId, text, senecaCheckbox.checked);
        textarea.value = '';
        renderNotesList(await fetchNotes(videoId), listEl);
        showToast(senecaCheckbox.checked ? 'Saved to notes + Seneca' : 'Note saved');
      } catch (err) {
        showToast(err.message === 'no-token' ? 'Add a Baserow token in settings' : 'Failed to save note');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }

    saveBtn.addEventListener('click', doSave);
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doSave();
    });
  }

  function removeNotesPanel() {
    document.getElementById(NOTES_PANEL_ID)?.remove();
  }

  // ── SPA navigation handling ──────────────────────────────────────────────────

  let lastUrl = location.href;

  function handleNavigation() {
    closePicker();
    document.getElementById(BTN_ID)?.remove();
    removeNotesPanel();
    clearFolderFilter();
    setTimeout(() => {
      injectButton();
      injectSidebarLink();
      injectSubscriptionBadges();
      injectFolderChips();
      injectNotesPanel();
    }, 500);
  }

  // YouTube fires this custom event on SPA navigation
  document.addEventListener('yt-navigate-finish', handleNavigation);

  // Fallback: poll for URL changes (some YouTube layouts don't fire the event)
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      handleNavigation();
    }
  }, 1000);

  // Initial injection
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      injectButton(); injectSidebarLink(); injectSubscriptionBadges(); injectFolderChips(); injectNotesPanel();
    });
  } else {
    injectButton();
    injectSidebarLink();
    injectSubscriptionBadges();
    injectFolderChips();
    injectNotesPanel();
  }

  // Sidebar may render later — watch for guide entries to appear.
  // Also re-inject home chips if YouTube re-renders the feed after navigation.
  const guideObserver = new MutationObserver(() => {
    if (!document.getElementById(SIDEBAR_ID)) injectSidebarLink();
    rewriteSubscriptionLinks();
    if (location.pathname === '/' && !document.getElementById(CHIPS_ID) && !chipsInjecting) {
      clearTimeout(chipReinjectTimer);
      chipReinjectTimer = setTimeout(injectFolderChips, 600);
    }
  });
  guideObserver.observe(document.body, { childList: true, subtree: true });
})();
