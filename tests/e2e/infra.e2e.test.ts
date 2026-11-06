import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { N8N_URL, ROOT, stub } from './lib';

describe('e2e infrastructure', () => {
  it('n8n is healthy', async () => {
    const res = await fetch(`${N8N_URL}/healthz`);
    expect(res.ok).toBe(true);
  });

  it('anthropic stub starts with no recorded requests', async () => {
    expect(await stub.requests()).toEqual([]);
  });

  it('bootstrap loaded both credentials into n8n', () => {
    const out = execFileSync(
      'docker',
      ['compose', '-f', join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', 'n8n', 'n8n', 'export:credentials', '--all'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    // The CLI prints log lines before the JSON array.
    const json = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('[{'));
    const creds = JSON.parse(json!);
    const names = creds.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['Anthropic', 'JobHunter Postgres']);
  });
});
