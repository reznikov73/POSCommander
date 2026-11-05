export interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
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
  statfs(path: string): Promise<{ total: number; free: number; error?: string }>;
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
}

declare global {
  interface Window { pos: PosApi }
}
