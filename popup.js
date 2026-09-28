const FOLDER_SVG = '<svg style="display:inline-block;width:.9em;height:.8em;vertical-align:-.1em" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5a1.5 1.5 0 0 1 1.5-1.5h5l2 2.5H17.5A1.5 1.5 0 0 1 19 7.5v6A1.5 1.5 0 0 1 17.5 15h-15A1.5 1.5 0 0 1 1 13.5V5z"/></svg>';

document.getElementById('manage-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('empty-manage-btn')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function render() {
  const foldersWithChannels = await Storage.getFoldersWithChannels();
  const list = document.getElementById('folder-list');
  const empty = document.getElementById('empty-state');

  list.innerHTML = '';

  if (foldersWithChannels.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  foldersWithChannels.forEach(folder => {
    const section = document.createElement('div');
    section.className = 'folder-section';

    const header = document.createElement('button');
    header.className = 'folder-header';
    header.innerHTML = `
      <span class="folder-icon">${FOLDER_SVG}</span>
      <span class="folder-name">${escHtml(folder.name)}</span>
      <span class="folder-count">${folder.channels.length}</span>
      <span class="folder-chevron">▾</span>
    `;

    const channelList = document.createElement('div');
    channelList.className = 'channel-list';

    if (folder.channels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'channel-empty';
      empty.textContent = 'No channels';
      channelList.appendChild(empty);
    } else {
      folder.channels.forEach(ch => {
        const item = document.createElement('a');
        item.className = 'channel-item';
        item.href = ch.url;
        item.target = '_blank';
        item.rel = 'noopener';
        item.innerHTML = `
          ${ch.thumbnail ? `<img class="channel-thumb" src="${escHtml(ch.thumbnail)}" alt="">` : '<span class="channel-thumb-placeholder">▶</span>'}
          <span class="channel-name">${escHtml(ch.name || ch.handle || ch.id)}</span>
        `;
        channelList.appendChild(item);
      });
    }

    header.addEventListener('click', () => {
      const open = section.classList.toggle('open');
      header.querySelector('.folder-chevron').textContent = open ? '▴' : '▾';
    });

    section.classList.add('open'); // default open
    header.querySelector('.folder-chevron').textContent = '▴';

    section.appendChild(header);
    section.appendChild(channelList);
    list.appendChild(section);
  });
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

render();
