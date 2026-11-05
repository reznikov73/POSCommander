import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Типы, общие с main (дублируются минимально)
export interface PosApi {
  list(path: string): Promise<{ path: string; entries: PosEntry[]; error?: string }>;
  statfs(path: string): Promise<{ total: number; free: number; error?: string }>;
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
}

export interface PosEntry { name: string; isDir: boolean; size: number; mtime: number }
export interface PosDrive { letter: string; root: string; label: string; type: string; total: number; free: number }

const api: PosApi = {
  list: (p) => ipcRenderer.invoke('fs:list', p),
  statfs: (p) => ipcRenderer.invoke('fs:statfs', p),
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
};

contextBridge.exposeInMainWorld('pos', api);
