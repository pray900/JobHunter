import fs from 'node:fs/promises';
import path from 'node:path';

export interface JobFile {
  name: string;
  bytes: Buffer;
}

export type ReadFile = (filePath: string) => Promise<Buffer>;

export interface ListJobFilesOptions {
  // Test seam: lets tests simulate per-file read failures. Production uses fs.readFile.
  readFile?: ReadFile;
}

// The configured job folder does not exist. Callers must treat this as an error, not "no jobs".
export class JobFolderMissingError extends Error {
  readonly dir: string;
  constructor(dir: string) {
    super(`job folder not found: ${dir}`);
    this.name = 'JobFolderMissingError';
    this.dir = dir;
  }
}

// A listed file could not be read for a reason other than having been deleted.
export class JobFileReadError extends Error {
  readonly fileName: string;
  readonly code: string | undefined;
  constructor(fileName: string, cause: NodeJS.ErrnoException) {
    super(`failed to read job file ${fileName}: ${cause.code ?? cause.message}`, { cause });
    this.name = 'JobFileReadError';
    this.fileName = fileName;
    this.code = cause.code;
  }
}

const hasCode = (err: unknown, code: string): boolean => (err as NodeJS.ErrnoException)?.code === code;

// The only module that reads the job folder from disk.
export async function listJobFiles(dir: string, opts: ListJobFilesOptions = {}): Promise<JobFile[]> {
  const readFile: ReadFile = opts.readFile ?? ((p) => fs.readFile(p));

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (hasCode(err, 'ENOENT')) throw new JobFolderMissingError(dir);
    throw err;
  }

  const names = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.docx$/i.test(name) && !name.startsWith('~$') && !name.startsWith('.'))
    .sort();

  const files = await Promise.all(
    names.map(async (name): Promise<JobFile | null> => {
      try {
        return { name, bytes: await readFile(path.join(dir, name)) };
      } catch (err) {
        // Deleted between readdir and read: it is truly gone, so omit it.
        if (hasCode(err, 'ENOENT')) return null;
        throw new JobFileReadError(name, err as NodeJS.ErrnoException);
      }
    }),
  );
  return files.filter((f): f is JobFile => f !== null);
}
