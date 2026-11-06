import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ROOT } from './lib';

// Sourcing the bootstrap only defines its settings and functions: no stack is touched.
// The env file is always a temp copy (JOBHUNTER_ENV_FILE), never the real .env.
const SCRIPT = join(ROOT, 'scripts', 'n8n-bootstrap.sh');

function sourced(body: string, envFile: string, args: string[] = []): string {
  return execFileSync('bash', ['-c', `. "$SCRIPT" "$@"\n${body}`, 'bash', ...args], {
    cwd: tmpdir(),
    env: { ...process.env, SCRIPT, JOBHUNTER_ENV_FILE: envFile },
    encoding: 'utf8',
  });
}

/** C:\a\b -> /c/a/b, the form Git Bash itself produces. */
const gitBashPath = (p: string) => p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');

describe('bootstrap script helpers', () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-bootstrap-'));
    envFile = join(dir, '.env');
    copyFileSync(join(ROOT, '.env.example'), envFile);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.each([
    ['native path', (p: string) => p],
    ['Git Bash path', gitBashPath],
  ])('fills empty owner lines from a fresh .env.example (%s)', (_, toPath) => {
    const out = sourced('ensure_owner_login', toPath(envFile));
    expect(out).toContain('n8n owner login saved in .env');
    const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith('N8N_OWNER_EMAIL='))).toEqual(['N8N_OWNER_EMAIL=prayush@jobhunter.local']);
    const pw = lines.filter((l) => l.startsWith('N8N_OWNER_PASSWORD='));
    expect(pw).toHaveLength(1);
    expect(pw[0]).toMatch(/^N8N_OWNER_PASSWORD=[A-Za-z0-9_-]{32}Aa1$/);
    // Every other line is unchanged.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    expect(lines.filter((l) => !l.startsWith('N8N_OWNER_'))).toEqual(example.filter((l) => !l.startsWith('N8N_OWNER_')));
  });

  test('keeps an existing owner login', () => {
    writeFileSync(envFile, 'N8N_OWNER_EMAIL=me@x.io\nN8N_OWNER_PASSWORD=Keep-Me-1\n');
    const out = sourced('ensure_owner_login', envFile);
    expect(out).not.toContain('saved');
    expect(readFileSync(envFile, 'utf8')).toBe('N8N_OWNER_EMAIL=me@x.io\nN8N_OWNER_PASSWORD=Keep-Me-1\n');
  });

  test('env_value strips one pair of matching surrounding quotes', () => {
    writeFileSync(envFile, ['A="sk-dq"', "B='sk-sq'", 'C=plain', 'D="unmatched', 'E=""', 'F="a"b"', 'G=x=y\r', ''].join('\n'));
    const out = sourced('for k in A B C D E F G; do printf "%s=[%s]\\n" "$k" "$(env_value "$k")"; done', envFile);
    expect(out.trim().split('\n')).toEqual(['A=[sk-dq]', 'B=[sk-sq]', 'C=[plain]', 'D=["unmatched]', 'E=[]', 'F=[a"b]', 'G=[x=y]']);
  });

  test('default compose file resolves to a path docker and node can open', () => {
    const out = sourced('printf "%s\\n%s\\n" "$COMPOSE_FILE" "$IS_TEST_STACK"; docker compose -f "$COMPOSE_FILE" config -q', envFile);
    const [composeFile, isTest] = out.trim().split('\n');
    expect(existsSync(composeFile)).toBe(true);
    expect(composeFile.replace(/\\/g, '/').toLowerCase()).toBe(join(ROOT, 'docker-compose.yml').replace(/\\/g, '/').toLowerCase());
    expect(isTest).toBe('0');
  });

  test('a Git Bash compose path is converted and detected as the test stack', () => {
    const out = sourced('printf "%s\\n%s\\n" "$COMPOSE_FILE" "$IS_TEST_STACK"', envFile, [gitBashPath(join(ROOT, 'docker-compose.test.yml'))]);
    const [composeFile, isTest] = out.trim().split('\n');
    expect(existsSync(composeFile)).toBe(true);
    expect(isTest).toBe('1');
  });
});
