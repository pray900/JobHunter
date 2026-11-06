import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocumentKind } from '../documents/types.js';

export interface StoredDocument {
  name: string;
  // null when the file is over MAX_DOCUMENT_BYTES (never read into memory).
  bytes: Buffer | null;
  contentHash: string;
}

export interface CurrentDocument {
  name: string;
  contentHash: string;
}

// The pointer file's content: which stored copy is current.
interface Pointer extends CurrentDocument {
  id: string;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export class InvalidDocumentNameError extends Error {
  constructor() {
    super('invalid document name');
    this.name = 'InvalidDocumentNameError';
  }
}

// The stored file could not be read for a reason other than having been removed.
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

// Only these characters, no separators and no `..`: a name that is safe to use as a file name.
const SAFE_NAME = /^[A-Za-z0-9 ._()-]+$/;
const isSafeName = (name: string): boolean => isAcceptedName(name) && SAFE_NAME.test(name) && !name.includes('..');

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
  if (stem.replace(/[. ]/g, '') === '' || !isSafeName(name)) return null;
  return name;
}

export interface DocumentStore {
  // The one stored document of this kind, with its content; null when the slot is empty.
  readDocument(kind: DocumentKind): Promise<StoredDocument | null>;
  // Name and content hash of the stored document, without reading the document itself.
  currentDocument(kind: DocumentKind): Promise<CurrentDocument | null>;
  // Stores the document and removes the previous one of this kind. A failed write keeps the previous one.
  saveDocument(kind: DocumentKind, name: string, bytes: Buffer): Promise<void>;
}

export type DocumentLog = (message: string, context: Record<string, unknown>) => void;

export interface DocumentStoreOptions {
  log?: DocumentLog;
  // Test seam for the write of the new file.
  writeFile?: (file: string, bytes: Buffer) => Promise<void>;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// Which stored copy in the kind's folder is the current document. Switched with one atomic rename.
const POINTER = '.current.json';
const COPY_ID = /^[0-9a-f]{16}$/;

// The only module that touches the stored CVs and cover letters on disk.
// Layout: <root>/<kind>/<copy id>/<file name>, plus <root>/<kind>/.current.json naming the current copy.
// Each save writes a new copy, so the previous document is never touched until the switch is done.
export function createDocumentStore(root: string, opts: DocumentStoreOptions = {}): DocumentStore {
  const log = opts.log ?? (() => {});
  const writeFile = opts.writeFile ?? ((file: string, bytes: Buffer) => fs.writeFile(file, bytes, { flag: 'wx' }));
  const dirOf = (kind: DocumentKind) => path.join(root, kind);
  // Saves of one kind run one after another, and reads wait for a save in progress, so a replace
  // never races another replace and a read never sees a half-finished one (the worker is one process).
  const queues = new Map<DocumentKind, Promise<unknown>>();
  const settled = async (kind: DocumentKind): Promise<void> => {
    await (queues.get(kind) ?? Promise.resolve()).catch(() => {});
  };

  async function readPointer(kind: DocumentKind): Promise<Pointer | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dirOf(kind), POINTER), 'utf8');
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Pointer>;
      if (
        typeof parsed.id !== 'string' || !COPY_ID.test(parsed.id) ||
        typeof parsed.name !== 'string' || !isSafeName(parsed.name) ||
        typeof parsed.contentHash !== 'string'
      ) {
        return null;
      }
      return { id: parsed.id, name: parsed.name, contentHash: parsed.contentHash };
    } catch {
      return null;
    }
  }

  async function removeQuietly(file: string, kind: DocumentKind): Promise<void> {
    try {
      await fs.rm(file, { recursive: true, force: true });
    } catch (err) {
      log('document cleanup failed', { kind, code: (err as NodeJS.ErrnoException)?.code });
    }
  }

  async function save(kind: DocumentKind, name: string, bytes: Buffer): Promise<void> {
    if (!isSafeName(name)) throw new InvalidDocumentNameError();
    const dir = dirOf(kind);
    const id = randomBytes(8).toString('hex');
    const copyDir = path.join(dir, id);
    const pointerTmp = path.join(dir, `.pointer-${id}.tmp`);
    try {
      // 1. Write the new document as a new copy (temp file, then rename); the previous one is not touched.
      await fs.mkdir(copyDir, { recursive: true });
      const tmp = path.join(copyDir, '.upload.tmp');
      await writeFile(tmp, bytes);
      await fs.rename(tmp, path.join(copyDir, name));
      // 2. Switch: one atomic rename of the pointer makes the new copy the current document.
      await fs.writeFile(pointerTmp, JSON.stringify({ id, name, contentHash: sha256(bytes) }), { flag: 'wx' });
      await fs.rename(pointerTmp, path.join(dir, POINTER));
    } catch (err) {
      await removeQuietly(copyDir, kind);
      await removeQuietly(pointerTmp, kind);
      throw err;
    }
    // 3. Remove the previous document (and anything left over from an interrupted save). The new
    // document is already current, so a failed clean-up is only logged; the next save retries it.
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      log('document cleanup failed', { kind, code: (err as NodeJS.ErrnoException)?.code });
    }
    for (const entry of entries) {
      if (entry !== id && entry !== POINTER) await removeQuietly(path.join(dir, entry), kind);
    }
  }

  return {
    currentDocument: async (kind) => {
      await settled(kind);
      const current = await readPointer(kind);
      if (!current) return null;
      try {
        await fs.stat(path.join(dirOf(kind), current.id, current.name));
      } catch (err) {
        if (hasCode(err, 'ENOENT')) return null;
        throw err;
      }
      return { name: current.name, contentHash: current.contentHash };
    },

    async readDocument(kind) {
      await settled(kind);
      const current = await readPointer(kind);
      if (!current) return null;
      const { name } = current;
      const filePath = path.join(dirOf(kind), current.id, name);
      try {
        const stat = await fs.stat(filePath);
        // Oversize files are hashed by streaming and never held in memory.
        if (stat.size > MAX_DOCUMENT_BYTES) return { name, bytes: null, contentHash: await sha256File(filePath) };
        const bytes = await fs.readFile(filePath);
        if (bytes.length > MAX_DOCUMENT_BYTES) return { name, bytes: null, contentHash: sha256(bytes) };
        return { name, bytes, contentHash: sha256(bytes) };
      } catch (err) {
        if (hasCode(err, 'ENOENT')) return null;
        throw new DocumentFileReadError(name, err as NodeJS.ErrnoException);
      }
    },

    saveDocument(kind, name, bytes) {
      const run = settled(kind).then(() => save(kind, name, bytes));
      queues.set(kind, run);
      return run;
    },
  };
}
