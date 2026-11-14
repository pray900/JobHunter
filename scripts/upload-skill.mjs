#!/usr/bin/env node
// Uploads skills/cv-writing to the Anthropic Skills API: creates the skill the first time
// (and saves CV_SKILL_ID in .env), adds a new version on later runs.
// Usage: node scripts/upload-skill.mjs [--env .env] [--dir skills/cv-writing] [--base-url https://api.anthropic.com]
// The key is read from the env file only. It is never printed and never put on a command line.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const usage = "Usage: node scripts/upload-skill.mjs [--env .env] [--dir skills/cv-writing] [--base-url https://api.anthropic.com]";
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) {
    console.error(`${name} needs a value.\n${usage}`);
    process.exit(1);
  }
  return args[i + 1];
};
const envFile = resolve(opt('--env', join(root, '.env')));
const dir = resolve(opt('--dir', join(root, 'skills', 'cv-writing')));
const baseUrl = opt('--base-url', 'https://api.anthropic.com').replace(/\/+$/, '');
const SKILL_ID = /^skill_[A-Za-z0-9]+$/;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// Same rules as scripts/n8n-bootstrap.sh env_value: last KEY= line, one pair of matching quotes stripped.
function envValue(text, key) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith(key + '='));
  let v = lines.length ? lines[lines.length - 1].slice(key.length + 1) : '';
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
  return v;
}

// Keeps the file's line endings. Replaces the last KEY= line and drops any earlier duplicates.
function setEnvValue(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => { if (l.startsWith(key + '=')) last = i; });
  if (last >= 0) {
    return lines.flatMap((l, i) => (i === last ? [key + '=' + value] : l.startsWith(key + '=') ? [] : [l])).join(eol);
  }
  return text + (text === '' || text.endsWith('\n') ? '' : eol) + key + '=' + value + eol;
}

function listFiles(base) {
  const out = [];
  for (const name of readdirSync(base).sort()) {
    const p = join(base, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(envFile)) fail(`Env file not found: ${envFile}`);
const envText = readFileSync(envFile, 'utf8');
const apiKey = envValue(envText, 'ANTHROPIC_API_KEY');
if (!apiKey) fail('ANTHROPIC_API_KEY is empty in the env file');
if (!existsSync(join(dir, 'SKILL.md'))) fail(`No SKILL.md in ${dir}`);

const top = basename(dir);
const form = new FormData();
for (const file of listFiles(dir)) {
  const rel = relative(dir, file).split(sep).join('/');
  form.append('files[]', new Blob([readFileSync(file)]), `${top}/${rel}`);
}

const existing = envValue(envText, 'CV_SKILL_ID');
const update = SKILL_ID.test(existing);
if (!update) form.append('display_name', 'CV writing');
const url = update ? `${baseUrl}/v1/skills/${existing}/versions` : `${baseUrl}/v1/skills`;

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
} catch (e) {
  fail(`Could not reach the Anthropic API (${(e.cause && e.cause.code) || e.name || 'error'}).`);
}
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  const e = body.error || {};
  const message = String(e.message || `HTTP ${res.status}`).split(apiKey).join('[key hidden]');
  fail(`Upload failed: ${e.type || 'error'}: ${message}`);
}

if (update) {
  console.log(`Skill ${existing}: new version ${body.id}`);
} else {
  if (!SKILL_ID.test(String(body.id))) fail("The API answer had no usable skill id.");
  // Print the id first, so a created skill is never lost if the env file cannot be written.
  console.log(`Skill ${body.id} created (version ${body.latest_version_id}).`);
  try {
    writeFileSync(envFile, setEnvValue(envText, "CV_SKILL_ID", body.id));
    console.log(`CV_SKILL_ID saved in ${basename(envFile)}.`);
  } catch (e) {
    fail(`Could not write CV_SKILL_ID to ${basename(envFile)} (${e.code || e.name}). Add this line yourself: CV_SKILL_ID=${body.id}`);
  }
}
