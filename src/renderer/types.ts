export interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  icon?: string;
}

export interface Drive {
  letter: string;
  root: string;
  label: string;
  type: string;
  total: number;
  free: number;
}

export type SortBy = 'name' | 'ext' | 'size' | 'date';

export interface PosApi {
  list(path: string): Promise<{ path: string; entries: Entry[]; error?: string }>;
  directorySize(path: string): Promise<number>;
  showProperties(path: string): Promise<string>;
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
  drives(): Promise<Drive[]>;
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

declare global {
  interface Window { pos: PosApi }
}
