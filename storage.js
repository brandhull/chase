// Shared storage utilities — included by popup.html and options.html
const Storage = {
  async get() {
    return new Promise(resolve =>
      chrome.storage.local.get({ folders: [], channels: [] }, resolve)
    );
  },

  async set(data) {
    return new Promise(resolve => chrome.storage.local.set(data, resolve));
  },

  async createFolder(name) {
    const data = await this.get();
    const folder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    data.folders.push(folder);
    await this.set({ folders: data.folders });
    return folder;
  },

  async renameFolder(folderId, name) {
    const data = await this.get();
    const f = data.folders.find(f => f.id === folderId);
    if (f) { f.name = name; await this.set({ folders: data.folders }); }
  },

  async deleteFolder(folderId) {
    const data = await this.get();
    data.folders  = data.folders.filter(f => f.id !== folderId);
    data.channels = data.channels.filter(c => c.folderId !== folderId);
    await this.set(data);
  },

  // Returns { added: true } or { alreadyExists: true }
  async addChannel(channelInfo, folderId) {
    const data = await this.get();
    if (data.channels.find(c => c.id === channelInfo.id && c.folderId === folderId)) {
      return { alreadyExists: true };
    }
    data.channels.push({ ...channelInfo, folderId, addedAt: Date.now() });
    await this.set({ channels: data.channels });
    return { added: true };
  },

  async moveChannel(channelId, fromFolderId, toFolderId) {
    const data = await this.get();
    // Remove from source
    const idx = data.channels.findIndex(c => c.id === channelId && c.folderId === fromFolderId);
    if (idx === -1) return;
    const [ch] = data.channels.splice(idx, 1);
    // Avoid duplicates in destination
    if (!data.channels.find(c => c.id === channelId && c.folderId === toFolderId)) {
      ch.folderId = toFolderId;
      data.channels.push(ch);
    }
    await this.set({ channels: data.channels });
  },

  async deleteChannel(channelId, folderId) {
    const data = await this.get();
    data.channels = data.channels.filter(c => !(c.id === channelId && c.folderId === folderId));
    await this.set({ channels: data.channels });
  },

  async getFoldersWithChannels() {
    const { folders, channels } = await this.get();
    return folders.map(f => ({
      ...f,
      channels: channels.filter(c => c.folderId === f.id)
        .sort((a, b) => a.addedAt - b.addedAt),
    }));
  },

  async reorderFolders(orderedIds) {
    const data = await this.get();
    data.folders = orderedIds
      .map(id => data.folders.find(f => f.id === id))
      .filter(Boolean);
    await this.set({ folders: data.folders });
  },

  async reorderChannels(folderId, orderedIds) {
    const data = await this.get();
    const others = data.channels.filter(c => c.folderId !== folderId);
    const folderChannels = data.channels.filter(c => c.folderId === folderId);
    const reordered = orderedIds
      .map(id => folderChannels.find(c => c.id === id))
      .filter(Boolean);
    data.channels = [...others, ...reordered];
    await this.set({ channels: data.channels });
  },
};
