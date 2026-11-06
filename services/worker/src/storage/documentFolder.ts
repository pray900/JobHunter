import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentKind } from '../documents/types.js';

export interface DocumentFile {
  name: string;
  // null when the file is over MAX_DOCUMENT_BYTES (never read into memory).
  bytes: Buffer | null;
  contentHash: string;
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
  // Exact name of an existing accepted file in the folder, or null. Never matches path-like names.
  findDocument(kind: DocumentKind, name: string): Promise<string | null>;
  writeDocument(kind: DocumentKind, name: string, bytes: Buffer, opts: { replace: boolean }): Promise<void>;
  deleteDocument(kind: DocumentKind, name: string): Promise<void>;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const hasPathTricks = (name: string): boolean => /[\/\0]/.test(name) || name.includes('..');

export type DocumentLog = (message: string, context: Record<string, unknown>) => void;

// The only module that touches the CV and cover letter folders on disk.
export function createDocumentFolders(dirs: DocumentDirs, log: DocumentLog = () => {}): DocumentFolders {
  async function readEntries(kind: DocumentKind) {
    const dir = dirs[kind];
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (hasCode(err, 'ENOENT')) throw new DocumentFolderMissingError(kind, dir);
      throw err;
    }
  }

  async function findDocument(kind: DocumentKind, name: string): Promise<string | null> {
    if (name === '' || hasPathTricks(name) || !isAcceptedName(name)) return null;
    const entries = await readEntries(kind);
    return entries.some((e) => e.isFile() && e.name === name) ? name : null;
  }

  // Safe names are used as-is; anything else must be an exact existing entry (e.g. a hand-placed file).
  async function resolveName(kind: DocumentKind, name: string): Promise<string> {
    if (isAcceptedName(name) && SAFE_NAME.test(name) && !name.includes('..')) return name;
    const found = await findDocument(kind, name);
    if (found === null) throw new InvalidDocumentNameError();
    return found;
  }

  return {
    findDocument,

    async listDocuments(kind) {
      const dir = dirs[kind];
      const names = (await readEntries(kind))
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter(isAcceptedName)
        .sort();
      const files = await Promise.all(
        names.map(async (name): Promise<DocumentFile | null> => {
          const filePath = path.join(dir, name);
          try {
            // Oversize files are hashed by streaming and never held in memory.
            if ((await fs.stat(filePath)).size > MAX_DOCUMENT_BYTES) {
              return { name, bytes: null, contentHash: await sha256File(filePath) };
            }
            const bytes = await fs.readFile(filePath);
            if (bytes.length > MAX_DOCUMENT_BYTES) return { name, bytes: null, contentHash: sha256(bytes) };
            return { name, bytes, contentHash: sha256(bytes) };
          } catch (err) {
            if (hasCode(err, 'ENOENT')) return null;
            throw new DocumentFileReadError(name, err as NodeJS.ErrnoException);
          }
        }),
      );
      return files.filter((f): f is DocumentFile => f !== null);
    },

    async writeDocument(kind, rawName, bytes, { replace }) {
      const dir = dirs[kind];
      const name = await resolveName(kind, rawName);
      const target = path.join(dir, name);
      const tmp = path.join(dir, `.upload-${randomBytes(8).toString('hex')}.tmp`);
      try {
        await fs.writeFile(tmp, bytes, { flag: 'wx' });
      } catch (err) {
        if (hasCode(err, 'ENOENT')) throw new DocumentFolderMissingError(kind, dir);
        throw err;
      }
      const removeTmp = async (): Promise<void> => {
        try {
          await fs.rm(tmp, { force: true });
        } catch (err) {
          log('temp file cleanup failed', { kind, code: (err as NodeJS.ErrnoException)?.code });
        }
      };
      try {
        if (replace) {
          await fs.rename(tmp, target);
          return;
        }
        // link/copy with EXCL fail with EEXIST instead of overwriting, so concurrent uploads cannot clobber a file.
        try {
          await fs.link(tmp, target);
        } catch (err) {
          if (hasCode(err, 'EEXIST')) throw new DocumentExistsError(name);
          // Some bind mounts (Docker Desktop on Windows) do not support hard links.
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].some((c) => hasCode(err, c))) throw err;
          try {
            await fs.copyFile(tmp, target, fsConstants.COPYFILE_EXCL);
          } catch (copyErr) {
            if (hasCode(copyErr, 'EEXIST')) throw new DocumentExistsError(name);
            throw copyErr;
          }
        }
        await removeTmp();
      } catch (err) {
        await removeTmp();
        throw err;
      }
    },

    async deleteDocument(kind, rawName) {
      const name = await resolveName(kind, rawName);
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
