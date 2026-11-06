import fs from 'node:fs/promises';
import path from 'node:path';

export interface JobFile {
  name: string;
  bytes: Buffer;
}

// The only module that reads the job folder from disk.
export async function listJobFiles(dir: string): Promise<JobFile[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.docx$/i.test(name) && !name.startsWith('~$') && !name.startsWith('.'))
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, bytes: await fs.readFile(path.join(dir, name)) })),
  );
}
