import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentKind } from '../documents/types.js';

export interface DocumentFile {
  name: string;
  bytes: Buffer;
}

export type DocumentDirs = Record<DocumentKind, string>;

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// The configured document folder does not exist. Callers must treat this as an error, not "no documents".
export class DocumentFolderMissingError extends Error {
  readonly kind: DocumentKind;
  readonly dir: string;
  constructor(kind: DocumentKind, dir: string) {
    super(`document folder not found: ${dir}`);
    this.name = 'DocumentFolderMissingError';
    this.kind = kind;
    this.dir = dir;
  }
}

export class DocumentExistsError extends Error {
  constructor(readonly fileName: string) {
    super(`document already exists: ${fileName}`);
    this.name = 'DocumentExistsError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(readonly fileName: string) {
    super(`document not found: ${fileName}`);
    this.name = 'DocumentNotFoundError';
  }
}

export class InvalidDocumentNameError extends Error {
  constructor() {
    super('invalid document name');
    this.name = 'InvalidDocumentNameError';
  }
}

// A listed file could not be read for a reason other than having been deleted.
export class DocumentFileReadError extends Error {
  readonly fileName: string;
  readonly code: string | undefined;
  constructor(fileName: string, cause: NodeJS.ErrnoException) {
    super(`failed to read document ${fileName}: ${cause.code ?? cause.message}`, { cause });
    this.name = 'DocumentFileReadError';
    this.fileName = fileName;
    this.code = cause.code;
  }
}

const hasCode = (err: unknown, code: string): boolean => (err as NodeJS.ErrnoException)?.code === code;
const ACCEPTED = /\.(pdf|docx)$/i;
const isAcceptedName = (name: string): boolean =>
  ACCEPTED.test(name) && !name.startsWith('~$') && !name.startsWith('.');

// A name that is already safe to use verbatim: no separators, no `..`, only allowed characters.
const SAFE_NAME = /^[A-Za-z0-9 ._()-]+$/;
function assertSafeName(name: string): void {
  if (!isAcceptedName(name) || !SAFE_NAME.test(name) || name.includes('..')) throw new InvalidDocumentNameError();
}

// Cleans an uploaded file name. Returns null when it cannot be made into a valid .pdf/.docx name.
export function sanitiseDocumentName(raw: string): string | null {
  // Reject these before stripping, otherwise "~$x.docx" would be cleaned into a valid-looking "x.docx".
  if (/[\\/]/.test(raw) || raw.startsWith('~$') || raw.startsWith('.')) return null;
  const ext = raw.match(/\.(pdf|docx)$/i)?.[0];
  if (!ext) return null;
  const stem = raw
    .slice(0, -ext.length)
    .replace(/[^A-Za-z0-9 ._()-]/g, '')
    .replace(/\.{2,}/g, '.');
  const name = `${stem}${ext}`;
  if (stem.replace(/[. ]/g, '') === '' || !isAcceptedName(name)) return null;
  return name;
}

export interface DocumentFolders {
  listDocuments(kind: DocumentKind): Promise<DocumentFile[]>;
  writeDocument(kind: DocumentKind, name: string, bytes: Buffer, opts: { replace: boolean }): Promise<void>;
  deleteDocument(kind: DocumentKind, name: string): Promise<void>;
}

// The only module that touches the CV and cover letter folders on disk.
export function createDocumentFolders(dirs: DocumentDirs): DocumentFolders {
  return {
    async listDocuments(kind) {
      const dir = dirs[kind];
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (hasCode(err, 'ENOENT')) throw new DocumentFolderMissingError(kind, dir);
        throw err;
      }
      const names = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter(isAcceptedName)
        .sort();
      const files = await Promise.all(
        names.map(async (name): Promise<DocumentFile | null> => {
          try {
            return { name, bytes: await fs.readFile(path.join(dir, name)) };
          } catch (err) {
            if (hasCode(err, 'ENOENT')) return null;
            throw new DocumentFileReadError(name, err as NodeJS.ErrnoException);
          }
        }),
      );
      return files.filter((f): f is DocumentFile => f !== null);
    },

    async writeDocument(kind, name, bytes, { replace }) {
      assertSafeName(name);
      const dir = dirs[kind];
      const target = path.join(dir, name);
      const tmp = path.join(dir, `.upload-${randomBytes(8).toString('hex')}.tmp`);
      try {
        await fs.writeFile(tmp, bytes, { flag: 'wx' });
      } catch (err) {
        if (hasCode(err, 'ENOENT')) throw new DocumentFolderMissingError(kind, dir);
        throw err;
      }
      try {
        if (replace) {
          await fs.rename(tmp, target);
        } else {
          // link fails with EEXIST instead of overwriting, so concurrent uploads cannot clobber a file.
          try {
            await fs.link(tmp, target);
          } catch (err) {
            if (hasCode(err, 'EEXIST')) throw new DocumentExistsError(name);
            // Some bind mounts (Docker Desktop on Windows) do not support hard links: check, then rename.
            if (!hasCode(err, 'EPERM') && !hasCode(err, 'ENOTSUP') && !hasCode(err, 'EOPNOTSUPP') && !hasCode(err, 'EXDEV')) throw err;
            const exists = await fs.lstat(target).then(() => true, () => false);
            if (exists) throw new DocumentExistsError(name);
            await fs.rename(tmp, target);
          }
          await fs.rm(tmp, { force: true });
        }
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
    },

    async deleteDocument(kind, name) {
      assertSafeName(name);
      const target = path.join(dirs[kind], name);
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (err) {
        if (hasCode(err, 'ENOENT')) throw new DocumentNotFoundError(name);
        throw err;
      }
      if (!stat.isFile()) throw new DocumentNotFoundError(name);
      try {
        await fs.unlink(target);
      } catch (err) {
        if (hasCode(err, 'ENOENT')) throw new DocumentNotFoundError(name);
        throw err;
      }
    },
  };
}
