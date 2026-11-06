import { createHash } from 'node:crypto';
import { listJobFiles } from '../storage/jobFolder.js';
import { parseJobDocx } from './parseJobDocx.js';
import type { ScannedJob } from './types.js';

export async function scanJobFolder(dir: string): Promise<ScannedJob[]> {
  const files = await listJobFiles(dir);
  return Promise.all(
    files.map(async (file) => {
      const parsed = await parseJobDocx(file.bytes);
      return {
        source: 'folder' as const,
        sourceRef: file.name,
        contentHash: createHash('sha256').update(file.bytes).digest('hex'),
        url: parsed.url,
        body: parsed.body,
        warnings: parsed.warnings,
      };
    }),
  );
}
