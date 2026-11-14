// Minimal Anthropic Messages API stub for e2e tests.
// Answers by request purpose: the first line of the system prompt is "purpose: <name>".
// A system prompt without that line is Plan 1's job extraction ("extract_job").
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const CANNED = {
  extract_job: {
    title: 'Stub Title',
    employer: 'Stub Employer',
    advertiser: null,
    short_description: 'Stub description.',
  },
  // workRights is null so the worker's checks report missing_work_rights.
  analyse_cv: {
    name: 'Stub Person',
    headline: 'Stub Headline',
    summary: 'Stub summary.',
    workRights: null,
    education: [{ qualification: 'Stub Degree', institution: 'Stub University', dates: '2020 – 2023', statusText: 'Completed' }],
    roles: [{ title: 'Stub Engineer', employer: 'Stub Employer', dates: '2023 – 2024', bullets: ['Led a team of 5'] }],
    projects: [{ name: 'Stub Project', bullets: ['Built a stub'] }],
    skills: ['TypeScript'],
    metrics: ['team of 5'],
    contact: { location: 'Sydney', email: null, phone: null, links: [] },
  },
  analyse_cover_letter: {
    previousTarget: { company: 'Stub Company', addressee: null, role: 'Stub Role' },
    reusableParagraphs: ['Stub paragraph.'],
    toneNotes: 'Stub tone.',
  },
  // Built only from the analyse_cv facts above, so it passes the worker's strict checks against them.
  write_documents: {
    templateId: 'standard-ats',
    templateReason: 'Standard ATS is the only template and suits this role.',
    cv: {
      name: 'Stub Person',
      headline: 'Stub Engineer',
      contact: { location: 'Sydney', email: null, phone: null, links: [] },
      summary: 'Engineer who builds and leads small stub teams.',
      workRights: null,
      skills: [{ group: 'Languages', items: ['TypeScript'] }],
      experience: [
        { title: 'Stub Engineer', employer: 'Stub Employer', location: null, dates: '2023 – 2024', bullets: ['Led a team of 5'] },
      ],
      education: [{ qualification: 'Stub Degree', institution: 'Stub University', dates: '2020 – 2023', statusText: 'Completed' }],
      projects: [{ name: 'Stub Project', bullets: ['Built a stub'] }],
    },
    coverLetter: {
      date: '7 November 2026',
      addressee: 'Hiring Manager',
      salutation: 'Dear Hiring Manager,',
      paragraphs: [
        'I am applying for this role. At Stub Employer I led a team and built a stub in TypeScript.',
        'I would welcome a conversation about how I can help your team.',
      ],
      signOff: 'Kind regards,',
      name: 'Stub Person',
    },
    keywordCoverage: { covered: ['TypeScript'], missing: [] },
    changes: [{ target: 'cv.headline', what: 'Headline names the role.', why: 'The job ad asks for an engineer.' }],
    stretches: [],
  },
  review_documents: {
    verdict: 'pass',
    items: [
      'relevance',
      'over_tailoring',
      'strongest_match_top_third',
      'inflated_scope',
      'ai_sounding',
      'paraphrased_job_ad',
      'keyword_stuffing',
      'bullet_rhythm',
      'star_form',
      'tidiness',
      'keyword_coverage_honest',
      'reasons_hold_up',
      'cover_letter_sources',
      'addressee',
    ].map((id) => ({ id, pass: true, note: 'Fine.' })),
    objections: [],
    factRulings: [],
    spellingRulings: [],
    stretches: [],
  },
  score_job: {
    score: 82,
    explanation: '82%: Stub match explanation.',
    matched: ['TypeScript'],
    missing: [],
    notes: [],
  },
};

let requests = []; // { headers, body }
let failPurposes = new Set();
let delays = new Map(); // purpose -> ms to wait before answering
let scripts = new Map(); // purpose -> answers still to give, in order, before the canned one

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const err = (res, status, message) =>
  send(res, status, { type: 'error', error: { type: 'invalid_request_error', message } });

// Text the test can steer the stub with: text blocks, plus the bytes of base64 documents
// (test PDFs are plain text with a %PDF- header).
const blockText = (c) => {
  if (c?.type === 'document' && c.source?.type === 'base64') return Buffer.from(c.source.data ?? '', 'base64').toString('latin1');
  return c?.text ?? '';
};
const userText = (body) =>
  (body?.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(blockText).join('\n')))
    .join('\n');

const systemText = (body) =>
  typeof body?.system === 'string' ? body.system : (body?.system ?? []).map((b) => b.text ?? '').join('\n');
const purposeOf = (body) => /^purpose: *([a-z_]+)/.exec(systemText(body))?.[1] ?? 'extract_job';

// A request with container.skills (the cv-writing skill) needs the code-execution beta, as the real API does.
// Its answer reads the skill with code execution first, as measured on the real API (2026-11-14):
// server_tool_use > bash_code_execution_tool_result > text (the JSON).
const CODE_EXECUTION_BETA = 'code-execution-2025-08-25';
const hasSkills = (body) => Array.isArray(body?.container?.skills) && body.container.skills.length > 0;
const betasOf = (req) => String(req.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim());
const SKILL_READ = [
  { type: 'server_tool_use', id: 'srvtoolu_stub', name: 'bash_code_execution', input: { command: 'cat /skills/cv-writing/SKILL.md' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_stub',
    content: { type: 'bash_code_execution_result', stdout: '---\nname: cv-writing\n---', stderr: '', return_code: 0, content: [] },
  },
];

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/_requests') return send(res, 200, requests.map((r) => r.body));
    if (req.method === 'GET' && url === '/_request_log') return send(res, 200, requests);
    if (req.method === 'POST' && url === '/_reset') {
      requests = [];
      failPurposes = new Set();
      delays = new Map();
      scripts = new Map();
      return send(res, 200, { ok: true });
    }
    // Test control: every request with this purpose answers 500 until /_reset.
    if (req.method === 'POST' && url === '/_fail_purpose') {
      try {
        failPurposes.add(JSON.parse(Buffer.concat(chunks).toString('utf8')).purpose);
      } catch {
        return err(res, 400, 'invalid JSON');
      }
      return send(res, 200, { ok: true });
    }
    // Test control: requests with this purpose are recorded at once but answered after `ms`.
    if (req.method === 'POST' && url === '/_delay_purpose') {
      try {
        const { purpose, ms } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        delays.set(purpose, Number(ms));
      } catch {
        return err(res, 400, 'invalid JSON');
      }
      return send(res, 200, { ok: true });
    }
    // Test control: the next requests with this purpose get these answers in order, then the canned one.
    if (req.method === 'POST' && url === '/_script_purpose') {
      try {
        const { purpose, answers } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof purpose !== 'string' || !Array.isArray(answers)) throw new Error('bad shape');
        scripts.set(purpose, [...answers]);
      } catch {
        return err(res, 400, 'invalid JSON');
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });
    // Free key check used by the bootstrap. Not recorded in /_requests.
    if (req.method === 'GET' && url === '/v1/models') {
      if (req.headers['anthropic-version'] !== '2026-10-21')
        return err(res, 400, 'anthropic-version must be 2026-10-21');
      const key = req.headers['x-api-key'];
      if (!key || key === 'bad-key')
        return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return send(res, 200, { data: [{ type: 'model', id: 'claude-haiku-5-5' }], has_more: false });
    }
    if (req.method === 'POST' && url === '/v1/messages') {
      if (!req.headers['x-api-key']) return err(res, 400, 'x-api-key header required');
      if (req.headers['anthropic-version'] !== '2026-10-21')
        return err(res, 400, 'anthropic-version must be 2026-10-21');
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return err(res, 400, 'invalid JSON');
      }
      requests.push({ headers: req.headers, body });
      if (hasSkills(body) && !betasOf(req).includes(CODE_EXECUTION_BETA))
        return err(res, 400, `container.skills requires the ${CODE_EXECUTION_BETA} beta`);
      const purpose = purposeOf(body);
      const text = userText(body);
      if (text.includes('STUB_FAIL') || failPurposes.has(purpose))
        return send(res, 500, { type: 'error', error: { type: 'api_error', message: 'stub failure' } });
      // "STUB_MODEL:<id>" in a document makes the answer report that model (as a server-side fallback would).
      const answeredModel = /STUB_MODEL:(\S+)/.exec(text)?.[1];
      const base = { id: 'msg_stub', type: 'message', role: 'assistant', model: answeredModel ?? body.model ?? 'stub' };
      if (text.includes('STUB_REFUSE'))
        return send(res, 200, { ...base, content: [], stop_reason: 'refusal', usage: { input_tokens: 1000, output_tokens: 100 } });
      let answer = scripts.get(purpose)?.shift() ?? CANNED[purpose] ?? CANNED.extract_job;
      // A scripted { __stub_status: 529 } answers that HTTP error instead (no usage), e.g. to fail round 2 only.
      if (answer && typeof answer.__stub_status === 'number')
        return send(res, answer.__stub_status, { type: 'error', error: { type: 'api_error', message: 'scripted stub failure' } });
      // "STUB_HEADLINE:<text>" in a CV makes its recorded headline <text> (so tests can tell CVs apart).
      const headline = /STUB_HEADLINE:(\S+)/.exec(text)?.[1];
      if (purpose === 'analyse_cv' && headline) answer = { ...answer, headline };
      // A scripted { __stub_content: [blocks], __stub_stop_reason? } answers with exactly that content and stop
      // reason (default end_turn), e.g. text before a tool call, or a pause_turn. Any other answer is its JSON
      // as the last text block, after the skill read when the request carries container.skills.
      const scripted = answer && Array.isArray(answer.__stub_content);
      const content = scripted
        ? answer.__stub_content
        : [...(hasSkills(body) ? SKILL_READ : []), { type: 'text', text: JSON.stringify(answer) }];
      const stop_reason = scripted && typeof answer.__stub_stop_reason === 'string' ? answer.__stub_stop_reason : 'end_turn';
      const reply = () =>
        send(res, 200, {
          ...base,
          content,
          stop_reason,
          // The real API also returns the container it ran code in.
          ...(hasSkills(body) ? { container: { id: 'container_stub', expires_at: '2026-11-14T01:00:00Z' } } : {}),
          usage: { input_tokens: 1000, output_tokens: 100 },
        });
      const delay = delays.get(purpose);
      return delay ? setTimeout(reply, delay) : reply();
    }
    err(res, 404, 'not found');
  });
}).listen(PORT, () => console.log(`anthropic-stub listening on ${PORT}`));
