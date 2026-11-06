import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Типы, общие с main (дублируются минимально)
export interface PosApi {
  list(path: string): Promise<{ path: string; entries: PosEntry[]; error?: string }>;
  directorySize(path: string): Promise<number>;
  fileProperties(path: string): Promise<{ path: string; name: string; isDir: boolean; size: number; created: number; modified: number; accessed: number; readOnly: boolean; hidden: boolean; symbolicLink: boolean }>;
  fileIcons(paths: string[]): Promise<string[]>;
  createArchive(srcs: string[], archivePath: string, format: 'zip' | '7z' | 'tar', cwd: string, progressId?: string): Promise<string>;
  extractArchives(archives: string[], destination: string, progressId?: string): Promise<string>;
  extractArchiveEntries(entries: string[], destination: string, progressId?: string): Promise<string>;
  deleteArchiveEntries(entries: string[], progressId?: string): Promise<string>;
  addArchiveEntries(srcs: string[], destination: string, progressId?: string): Promise<string>;
  renameArchiveEntry(entry: string, newName: string, progressId?: string): Promise<string>;
  createArchiveFolder(path: string, progressId?: string): Promise<string>;
  extractArchiveFileForView(path: string, progressId?: string): Promise<{ path?: string; error?: string }>;
  statfs(path: string): Promise<{ total: number; free: number; error?: string }>;
  search(root: string, query: string): Promise<{ entries: Array<{ path: string; name: string; isDir: boolean; size: number; mtime: number }>; truncated: boolean }>;
  drives(): Promise<PosDrive[]>;
  mkdir(path: string): Promise<string>;
  rename(oldP: string, newP: string): Promise<string>;
  readText(path: string, max?: number): Promise<{ content: string; encoding: string; truncated: boolean; size: number; error?: string }>;
  openPath(path: string): Promise<string>;
  runCommand(command: string, cwd: string): Promise<string>;
  startOp(kind: string, srcs: string[], destDir: string): Promise<number>;
  cancelOp(opId: number): void;
  conflictReply(conflictId: number, answer: string): void;
  version(): Promise<string>;
  home(): Promise<string>;
  onOpEvent(cb: (data: any) => void): () => void;
  onArchiveProgress(cb: (data: { progressId: string; percent: number; currentFile: string }) => void): () => void;
}

export interface PosEntry { name: string; isDir: boolean; size: number; mtime: number; icon?: string }
export interface PosDrive { letter: string; root: string; label: string; type: string; total: number; free: number }

const api: PosApi = {
  list: (p) => ipcRenderer.invoke('fs:list', p),
  directorySize: (p) => ipcRenderer.invoke('fs:directorySize', p),
  fileProperties: (p) => ipcRenderer.invoke('fs:properties', p),
  fileIcons: (paths) => ipcRenderer.invoke('fs:fileIcons', paths),
  createArchive: (srcs, archivePath, format, cwd, progressId) => ipcRenderer.invoke('archive:create', { srcs, archivePath, format, cwd, progressId }),
  extractArchives: (archives, destination, progressId) => ipcRenderer.invoke('archive:extract', { archives, destination, progressId }),
  extractArchiveEntries: (entries, destination, progressId) => ipcRenderer.invoke('archive:extractEntries', { entries, destination, progressId }),
  deleteArchiveEntries: (entries, progressId) => ipcRenderer.invoke('archive:deleteEntries', { entries, progressId }),
  addArchiveEntries: (srcs, destination, progressId) => ipcRenderer.invoke('archive:addEntries', { srcs, destination, progressId }),
  renameArchiveEntry: (entry, newName, progressId) => ipcRenderer.invoke('archive:renameEntry', { entry, newName, progressId }),
  createArchiveFolder: (p, progressId) => ipcRenderer.invoke('archive:createFolder', { path: p, progressId }),
  extractArchiveFileForView: (p, progressId) => ipcRenderer.invoke('archive:extractForView', { path: p, progressId }),
  statfs: (p) => ipcRenderer.invoke('fs:statfs', p),
  search: (root, query) => ipcRenderer.invoke('fs:search', { root, query }),
  drives: () => ipcRenderer.invoke('fs:drives'),
  mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  rename: (o, n) => ipcRenderer.invoke('fs:rename', o, n),
  readText: (p, m) => ipcRenderer.invoke('fs:readText', p, m),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  runCommand: (command, cwd) => ipcRenderer.invoke('shell:run', command, cwd),
  startOp: (kind, srcs, destDir) => ipcRenderer.invoke('ops:start', { kind, srcs, destDir }),
  cancelOp: (opId) => ipcRenderer.send('ops:cancel', opId),
  conflictReply: (conflictId, answer) => ipcRenderer.send('ops:conflict-reply', { conflictId, answer }),
  version: () => ipcRenderer.invoke('app:version'),
  home: () => ipcRenderer.invoke('app:home'),
  onOpEvent: (cb) => {
    const handler = (_e: IpcRendererEvent, data: any) => cb(data);
    ipcRenderer.on('op:progress', handler);
    ipcRenderer.on('op:done', handler);
    ipcRenderer.on('op:conflict', handler);
    return () => {
      ipcRenderer.removeListener('op:progress', handler);
      ipcRenderer.removeListener('op:done', handler);
      ipcRenderer.removeListener('op:conflict', handler);
    };
  },
  onArchiveProgress: (cb) => {
    const handler = (_e: IpcRendererEvent, data: { progressId: string; percent: number; currentFile: string }) => cb(data);
    ipcRenderer.on('archive:progress', handler);
    return () => ipcRenderer.removeListener('archive:progress', handler);
  },
};

contextBridge.exposeInMainWorld('pos', api);
