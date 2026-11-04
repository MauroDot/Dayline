import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State } from './model.ts';

/** Local single-host storage. Atomic replacement plus exclusive lock; not a production database. */
export class JsonRepository {
  readonly file: string;
  constructor(file: string) { this.file = file; }
  async read(): Promise<State> {
    try {
      const state: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!state || typeof state !== 'object' || (state as State).schema !== 1 || !['sources','revisions','approvals','audit'].every(k => Array.isArray((state as unknown as Record<string, unknown>)[k]))) throw Error('Invalid repository format');
      return structuredClone(state as State);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }
  async transact<T>(change: (state: State) => T): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let locked = false;
    for (let i = 0; i < 200; i++) {
      try { await mkdir(lock); locked = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (!locked) throw Error('Repository is locked; inspect before recovery');
    const temp = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = change(state);
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.file);
      return structuredClone(result);
    } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true, force: true }); }
  }
}
