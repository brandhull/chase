(() => {
  'use strict';

  const FOLDER_SVG = '<svg style="display:inline-block;width:.9em;height:.8em;vertical-align:-.1em" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5H17.5A1.5 1.5 0 0 1 19 7.5v6A1.5 1.5 0 0 1 17.5 15h-15A1.5 1.5 0 0 1 1 13.5V5z"/></svg>';

  let selectedFolderId = null;

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showError(msg) {
    const el = document.getElementById('modal-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearError() {
    document.getElementById('modal-error').classList.add('hidden');
  }

  // Parse a YouTube channel URL / handle into { id, handle, url, name }
  function parseInput(raw) {
    raw = raw.trim();
    if (!raw) return null;

    // Handle-only input: @channelname
    if (/^@[\w.-]+$/.test(raw)) {
      const handle = raw;
      return { id: handle, handle, url: `https://www.youtube.com/${handle}`, name: handle };
    }

    // Full URL
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      if (!u.hostname.includes('youtube.com')) return null;
      const path = u.pathname.replace(/\/$/, '');

      const hm = path.match(/\/@([\w.-]+)/);
      if (hm) {
        const handle = `@${hm[1]}`;
        return { id: handle, handle, url: `https://www.youtube.com/${handle}`, name: handle };
      }
      const cm = path.match(/\/channel\/(UC[\w-]+)/);
      if (cm) {
        const id = cm[1];
        return { id, handle: '', url: `https://www.youtube.com/channel/${id}`, name: id };
      }
      const lm = path.match(/\/c\/([\w.-]+)/);
      if (lm) {
        const id = `c:${lm[1]}`;
        return { id, handle: '', url: `https://www.youtube.com/c/${lm[1]}`, name: lm[1] };
      }
    } catch { /* fall through */ }

    return null;
  }

  // ── Drag-to-reorder helper ─────────────────────────────────────────────────
  // Attaches HTML5 drag events to a <ul>. Items need data-drag-id set.
  // onReorder(orderedIds) is called after a successful drop.

  function makeDraggable(listEl, onReorder) {
    let dragId = null;

    listEl.addEventListener('dragstart', (e) => {
      const item = e.target.closest('[data-drag-id]');
      if (!item) return;
      dragId = item.dataset.dragId;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    listEl.addEventListener('dragend', () => {
      listEl.querySelectorAll('.dragging, .drag-over').forEach(el => {
        el.classList.remove('dragging', 'drag-over');
      });
      dragId = null;
    });

    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('[data-drag-id]');
      listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      if (target && target.dataset.dragId !== dragId) target.classList.add('drag-over');
    });

    listEl.addEventListener('dragleave', (e) => {
      if (!listEl.contains(e.relatedTarget)) {
        listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      }
    });

    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('[data-drag-id]');
      if (!target || !dragId || target.dataset.dragId === dragId) return;

      const items = [...listEl.querySelectorAll('[data-drag-id]')];
      const fromIdx = items.findIndex(el => el.dataset.dragId === dragId);
      const toIdx   = items.findIndex(el => el.dataset.dragId === target.dataset.dragId);
      if (fromIdx === -1 || toIdx === -1) return;

      // Reorder DOM
      const [moved] = items.splice(fromIdx, 1);
      items.splice(toIdx, 0, moved);
      items.forEach(el => listEl.appendChild(el));

      // Persist
      onReorder(items.map(el => el.dataset.dragId));
    });
  }

  // ── Render sidebar folder list ─────────────────────────────────────────────

  async function renderFolders() {
    const { folders } = await Storage.get();
    const list = document.getElementById('folder-list');
    const noFolders = document.getElementById('no-folders');

    list.innerHTML = '';

    if (folders.length === 0) {
      noFolders.classList.remove('hidden');
    } else {
      noFolders.classList.add('hidden');
      folders.forEach(f => {
        const li = document.createElement('li');
        li.className = 'folder-item' + (f.id === selectedFolderId ? ' active' : '');
        li.dataset.id = f.id;
        li.dataset.dragId = f.id;
        li.draggable = true;
        li.innerHTML = `<span class="drag-handle" title="Drag to reorder">⠿</span><span class="fi">${FOLDER_SVG}</span><span class="fn">${escHtml(f.name)}</span>`;
        li.addEventListener('click', (e) => {
          if (!e.target.closest('.drag-handle')) selectFolder(f.id);
        });
        list.appendChild(li);
      });

      makeDraggable(list, (orderedIds) => Storage.reorderFolders(orderedIds));
    }
  }

  // ── Select folder & render channels ──────────────────────────────────────

  async function selectFolder(folderId) {
    selectedFolderId = folderId;

    // Update sidebar active state
    document.querySelectorAll('.folder-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === folderId);
    });

    const { folders, channels } = await Storage.get();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    document.getElementById('placeholder').classList.add('hidden');
    const panel = document.getElementById('folder-panel');
    panel.classList.remove('hidden');
    document.getElementById('panel-title').textContent = folder.name;

    const folderChannels = channels
      .filter(c => c.folderId === folderId)
      .sort((a, b) => (a.name || a.handle || a.id).localeCompare(b.name || b.handle || b.id, undefined, { sensitivity: 'base' }));

    const emptyEl = document.getElementById('channels-empty');
    const listEl  = document.getElementById('channel-list');
    listEl.innerHTML = '';

    if (folderChannels.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      folderChannels.forEach(ch => renderChannelItem(ch, folders, listEl));
      makeDraggable(listEl, (orderedIds) => Storage.reorderChannels(folderId, orderedIds));
    }
  }

  function renderChannelItem(ch, allFolders, listEl) {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.dataset.id = ch.id;
    li.dataset.folderId = ch.folderId;
    li.dataset.dragId = `${ch.id}::${ch.folderId}`;
    li.draggable = true;

    const otherFolders = allFolders.filter(f => f.id !== ch.folderId);
    const moveOptions = otherFolders.map(f =>
      `<option value="${escHtml(f.id)}">${escHtml(f.name)}</option>`
    ).join('');

    li.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="ch-left">
        <div class="ch-info">
          <a class="ch-name" href="${escHtml(ch.url)}" target="_blank" rel="noopener">
            ${escHtml(ch.name || ch.handle || ch.id)}
          </a>
          ${ch.handle ? `<span class="ch-handle">${escHtml(ch.handle)}</span>` : ''}
        </div>
      </div>
      <div class="ch-actions">
        ${otherFolders.length > 0 ? `
          <select class="ch-move-select" title="Move to folder">
            <option value="">Move to…</option>
            ${moveOptions}
          </select>
        ` : ''}
        <button class="ch-delete-btn btn-icon-danger" title="Remove channel">🗑</button>
      </div>
    `;

    li.querySelector('.ch-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Remove "${ch.name || ch.id}" from this folder?`)) return;
      await Storage.deleteChannel(ch.id, ch.folderId);
      li.remove();
      const remaining = document.querySelectorAll('.channel-item');
      if (remaining.length === 0) document.getElementById('channels-empty').classList.remove('hidden');
    });

    const moveSelect = li.querySelector('.ch-move-select');
    if (moveSelect) {
      moveSelect.addEventListener('change', async () => {
        const toFolderId = moveSelect.value;
        if (!toFolderId) return;
        await Storage.moveChannel(ch.id, ch.folderId, toFolderId);
        li.remove();
        const remaining = document.querySelectorAll('.channel-item');
        if (remaining.length === 0) document.getElementById('channels-empty').classList.remove('hidden');
        moveSelect.value = '';
      });
    }

    listEl.appendChild(li);
  }

  // ── Add folder ─────────────────────────────────────────────────────────────

  document.getElementById('add-folder-btn').addEventListener('click', async () => {
    const name = prompt('Folder name:')?.trim();
    if (!name) return;
    const folder = await Storage.createFolder(name);
    await renderFolders();
    selectFolder(folder.id);
  });

  // ── Rename folder ──────────────────────────────────────────────────────────

  document.getElementById('rename-folder-btn').addEventListener('click', async () => {
    if (!selectedFolderId) return;
    const { folders } = await Storage.get();
    const folder = folders.find(f => f.id === selectedFolderId);
    const name = prompt('New name:', folder?.name ?? '')?.trim();
    if (!name) return;
    await Storage.renameFolder(selectedFolderId, name);
    await renderFolders();
    document.getElementById('panel-title').textContent = name;
  });

  // ── Delete folder ──────────────────────────────────────────────────────────

  document.getElementById('delete-folder-btn').addEventListener('click', async () => {
    if (!selectedFolderId) return;
    const { folders } = await Storage.get();
    const folder = folders.find(f => f.id === selectedFolderId);
    if (!confirm(`Delete folder "${folder?.name}" and all its channels?`)) return;
    await Storage.deleteFolder(selectedFolderId);
    selectedFolderId = null;
    document.getElementById('folder-panel').classList.add('hidden');
    document.getElementById('placeholder').classList.remove('hidden');
    await renderFolders();
  });

  // ── Add channel modal ──────────────────────────────────────────────────────

  function openModal() {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-url').value = '';
    clearError();
    setTimeout(() => document.getElementById('modal-url').focus(), 50);
  }
  function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  document.getElementById('add-channel-btn').addEventListener('click', openModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.getElementById('modal-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('modal-submit').click();
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('modal-submit').addEventListener('click', async () => {
    clearError();
    const raw = document.getElementById('modal-url').value;
    const channelInfo = parseInput(raw);
    if (!channelInfo) {
      showError('Enter a valid YouTube channel URL or @handle.');
      return;
    }
    if (!selectedFolderId) return;

    const result = await Storage.addChannel(channelInfo, selectedFolderId);
    if (result.alreadyExists) {
      showError('This channel is already in this folder.');
      return;
    }

    closeModal();
    await selectFolder(selectedFolderId);
  });

  // ── Export ─────────────────────────────────────────────────────────────────

  document.getElementById('export-btn').addEventListener('click', async () => {
    const { folders, channels } = await Storage.get();
    const payload = JSON.stringify({ folders, channels }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `yto-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Import ─────────────────────────────────────────────────────────────────

  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      alert('Could not read file — make sure it is a valid YTO backup JSON.');
      return;
    }

    const { folders, channels } = parsed;
    if (!Array.isArray(folders) || !Array.isArray(channels)) {
      alert('Invalid backup file format.');
      return;
    }

    const existing = await Storage.get();
    const willOverwrite = existing.folders.length > 0 || existing.channels.length > 0;
    if (willOverwrite) {
      const ok = confirm(
        `This will merge the backup into your current data.\n` +
        `Backup: ${folders.length} folders, ${channels.length} channels.\n` +
        `Current: ${existing.folders.length} folders, ${existing.channels.length} channels.\n\n` +
        `Existing folders and channels with the same IDs will be kept as-is. Continue?`
      );
      if (!ok) return;
    }

    // Merge: add folders/channels from backup that don't already exist
    const mergedFolders = [...existing.folders];
    for (const f of folders) {
      if (!mergedFolders.find(x => x.id === f.id)) mergedFolders.push(f);
    }

    const mergedChannels = [...existing.channels];
    for (const c of channels) {
      if (!mergedChannels.find(x => x.id === c.id && x.folderId === c.folderId)) {
        mergedChannels.push(c);
      }
    }

    await Storage.set({ folders: mergedFolders, channels: mergedChannels });
    selectedFolderId = null;
    document.getElementById('folder-panel').classList.add('hidden');
    document.getElementById('placeholder').classList.remove('hidden');
    await renderFolders();
    alert(`Import complete: ${mergedFolders.length} folders, ${mergedChannels.length} channels.`);
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  async function loadSettings() {
    const { baserowToken, baserowNotesTableId, baserowSenecaTableId } = await new Promise(r =>
      chrome.storage.local.get({ baserowToken: '', baserowNotesTableId: '1128487', baserowSenecaTableId: '1116959' }, r)
    );
    document.getElementById('settings-token').value = baserowToken;
    document.getElementById('settings-notes-table').value = baserowNotesTableId;
    document.getElementById('settings-seneca-table').value = baserowSenecaTableId;
  }

  document.getElementById('settings-save-btn').addEventListener('click', async () => {
    const token = document.getElementById('settings-token').value.trim();
    const notesTable = document.getElementById('settings-notes-table').value.trim();
    const senecaTable = document.getElementById('settings-seneca-table').value.trim();
    await new Promise(r => chrome.storage.local.set({
      baserowToken: token,
      baserowNotesTableId: notesTable || '1128487',
      baserowSenecaTableId: senecaTable || '1116959',
    }, r));
    const status = document.getElementById('settings-status');
    status.textContent = 'Saved!';
    status.classList.remove('hidden', 'settings-status-error');
    setTimeout(() => status.classList.add('hidden'), 2000);
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  renderFolders();
  loadSettings();
})();
