// src/main.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync as spawnSync2 } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync as readFileSync3,
  rmSync,
} from 'node:fs';

// src/environment.ts
var DROPPED_PREFIXES = ['INPUT_', 'ACTIONS_', 'STATE_'];
var DROPPED_NAMES = /* @__PURE__ */ new Set([
  'GITHUB_TOKEN',
  'RUNNER_TRACKING_ID',
]);
function jobEnvironment(environment, secrets) {
  const hidden = new Set(secrets.filter(Boolean));
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry) =>
        typeof entry[1] === 'string' &&
        !DROPPED_NAMES.has(entry[0]) &&
        !DROPPED_PREFIXES.some((prefix) => entry[0].startsWith(prefix)) &&
        !hidden.has(entry[1])
    )
  );
}

// src/inventory.ts
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
var SECRET_INVENTORY_PATH = '/run/boba-secrets';
var RUNNER_SECRET_LIST_PATH = '/run/boba/secret-list';
var ARMOR = /^-{3,}/;
function readRunnerSecrets(path = RUNNER_SECRET_LIST_PATH) {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EACCES')
    )
      return null;
    throw error;
  }
}
function parseSecrets(json) {
  if (!json.trim()) return null;
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('secrets must be ${{ toJSON(secrets) }}');
  return Object.values(parsed).filter((value) => typeof value === 'string');
}
function secretInventory(values) {
  const lines = values
    .flatMap((value) => value.split('\n').map((line) => line.trim()))
    .filter((line) => line && !ARMOR.test(line));
  return [
    .../* @__PURE__ */ new Set([
      ...lines,
      ...lines.map((line) =>
        Buffer.from(`x-access-token:${line}`).toString('base64')
      ),
    ]),
  ];
}
function writeInventory(lines) {
  const path = SECRET_INVENTORY_PATH;
  const result = spawnSync(
    'sudo',
    [
      '-n',
      'sh',
      '-c',
      `umask 077 && cat > ${path}.new && mv -f ${path}.new ${path}`,
    ],
    {
      input: lines
        .map(
          (line) => `${line}
`
        )
        .join(''),
      stdio: ['pipe', 'ignore', 'inherit'],
      timeout: 5e3,
    }
  );
  return result.status === 0;
}

// src/api.ts
import { writeFileSync } from 'node:fs';

// src/github.ts
import { readFileSync as readFileSync2 } from 'node:fs';

// src/report.ts
var SUMMARY_LIMIT = 65535;
var ANNOTATIONS_PER_REQUEST = 50;
var COMMENT_MARKER = '<!-- coldtea-boba -->';
var MESSAGE_LIMIT = 4e3;
var RAW_DETAILS_LIMIT = 8e3;
var ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, 'g');
function conclude(input2) {
  const passed =
    input2.ran &&
    input2.counts.failed === 0 &&
    input2.suitePassed &&
    input2.globalErrors === 0 &&
    !input2.generationMismatch;
  return passed ? 'success' : 'failure';
}
function globalErrorMessages(report) {
  return (report.errors ?? []).map(
    (error) =>
      clean(error.message) || 'Playwright reported an error outside any test'
  );
}
function collectOutcomes(report) {
  const outcomes = [];
  const walk = (suite, describes) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results[test.results.length - 1];
        const failing = [...test.results]
          .reverse()
          .find((result) => result.status !== 'passed');
        outcomes.push({
          titlePath: [...describes, spec.title],
          project: test.projectName,
          file: spec.file,
          line: spec.line,
          status: test.status,
          durationMs: test.results.reduce(
            (ms, result) => ms + result.duration,
            0
          ),
          error: failing?.errors?.[0] ?? failing?.error ?? last?.error ?? null,
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, [...describes, child.title]);
    }
  };
  for (const fileSuite of report.suites) walk(fileSuite, []);
  return outcomes;
}
function parseReport(text) {
  const parsed = JSON.parse(text);
  if (!isReport(parsed)) {
    throw new Error('results.json is not a Playwright JSON report');
  }
  return parsed;
}
function isReport(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'suites' in value &&
    Array.isArray(value.suites)
  );
}
function countOutcomes(outcomes) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case 'expected':
        counts.passed += 1;
        break;
      case 'unexpected':
        counts.failed += 1;
        break;
      case 'flaky':
        counts.flaky += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
      default:
        return assertNever(outcome.status);
    }
  }
  return counts;
}
function toAnnotations(outcomes) {
  return outcomes.flatMap((outcome) => {
    switch (outcome.status) {
      case 'expected':
      case 'skipped':
        return [];
      case 'unexpected':
      case 'flaky': {
        const message =
          withoutCodeFrame(clean(outcome.error?.message)) || 'The test failed';
        const stack = clean(outcome.error?.stack);
        const line = Math.max(1, outcome.line);
        return [
          {
            path: outcome.file,
            start_line: line,
            end_line: line,
            annotation_level:
              outcome.status === 'unexpected' ? 'failure' : 'warning',
            title: `${outcome.status === 'flaky' ? 'Flaky: ' : ''}${outcome.titlePath.join(' \u203A ')}`,
            message: truncate(message, MESSAGE_LIMIT),
            ...(stack && stack !== message
              ? { raw_details: truncate(stack, RAW_DETAILS_LIMIT) }
              : {}),
          },
        ];
      }
      default:
        return assertNever(outcome.status);
    }
  });
}
function chunk(items, size = ANNOTATIONS_PER_REQUEST) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
function checkTitle(counts) {
  const parts = [`${counts.passed} passed`];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.flaky) parts.push(`${counts.flaky} flaky`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  return parts.join(', ');
}
function buildSummary(input2, limit = SUMMARY_LIMIT) {
  const counts = countOutcomes(input2.outcomes);
  const head = [
    `| Passed | Failed | Flaky | Skipped | Wall time | Tier |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| ${counts.passed} | ${counts.failed} | ${counts.flaky} | ${counts.skipped} | ${formatDuration(input2.wallMs)} | ${input2.tier} |`,
    '',
    ...(input2.reportUrl
      ? [`[Open the HTML report](${input2.reportUrl})`, '']
      : []),
    ...(input2.note ? [input2.note, ''] : []),
    ...(input2.globalErrors.length
      ? [
          '### Errors outside tests',
          '',
          ...input2.globalErrors.map(
            (message) =>
              `- ${escapeMarkdown(truncate(message.split('\n')[0], 300))}`
          ),
          '',
        ]
      : []),
  ].join('\n');
  const failures = input2.outcomes.filter(
    (outcome) => outcome.status === 'unexpected'
  );
  if (!failures.length) return truncate(head, limit);
  const lines = failures.map(
    (outcome) =>
      `- \`${outcome.file}:${outcome.line}\` ${escapeMarkdown(outcome.titlePath.join(' \u203A '))}`
  );
  const heading = '### Failed tests\n\n';
  let body = `${head}
${heading}`;
  for (const [index, line] of lines.entries()) {
    const rest = lines.length - index;
    const tail = `

${rest} more failed tests are in the report.`;
    if (body.length + line.length + 1 + tail.length > limit) {
      return `${body.trimEnd()}${tail}`;
    }
    body += `${line}
`;
  }
  return body.trimEnd();
}
function buildComment(summary, sha) {
  return `${COMMENT_MARKER}
## Boba

End-to-end results for ${sha.slice(0, 7)}.

${summary}`;
}
function formatDuration(ms) {
  if (ms === null) return 'n/a';
  const seconds = Math.round(ms / 1e3);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function clean(text) {
  return (text ?? '').replace(ANSI, '').trim();
}
function withoutCodeFrame(message) {
  return message
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(>\s*)?\d+ \|/.test(line) &&
        !/^\s+\|/.test(line) &&
        !/^\s+at /.test(line)
    )
    .join('\n')
    .trim();
}
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}
function escapeMarkdown(text) {
  return text.replace(/([\\`*_[\]<>|])/g, '\\$1');
}
function assertNever(value) {
  throw new Error(`Unhandled value: ${String(value)}`);
}

// src/github.ts
function buildCheckRunRequests(sha, output) {
  const summary = output.summary.slice(0, SUMMARY_LIMIT);
  const [first = [], ...rest] = chunk(output.annotations);
  return [
    {
      method: 'POST',
      body: {
        name: output.name,
        head_sha: sha,
        status: 'completed',
        conclusion: output.conclusion,
        ...(output.detailsUrl ? { details_url: output.detailsUrl } : {}),
        output: { title: output.title, summary, annotations: first },
      },
    },
    ...rest.map((annotations) => ({
      method: 'PATCH',
      body: { output: { title: output.title, summary, annotations } },
    })),
  ];
}
async function postCheckRun(context, requests) {
  let checkRun = null;
  for (const request of requests) {
    switch (request.method) {
      case 'POST': {
        const created = record(
          await call(
            context,
            'POST',
            `/repos/${context.repository}/check-runs`,
            request.body
          )
        );
        checkRun = { id: Number(created.id), url: String(created.html_url) };
        break;
      }
      case 'PATCH':
        if (!checkRun)
          throw new Error('A check run update came before its create');
        await call(
          context,
          'PATCH',
          `/repos/${context.repository}/check-runs/${checkRun.id}`,
          request.body
        );
        break;
      default:
        return assertNever2(request.method);
    }
  }
  return checkRun?.url ?? '';
}
function pullRequestNumber(eventPath) {
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync2(eventPath, 'utf8'));
    if (
      typeof event === 'object' &&
      event !== null &&
      'pull_request' in event &&
      typeof event.pull_request === 'object' &&
      event.pull_request !== null &&
      'number' in event.pull_request &&
      typeof event.pull_request.number === 'number'
    ) {
      return event.pull_request.number;
    }
  } catch {
    return null;
  }
  return null;
}
function findMarkedComment(comments) {
  return (
    comments.find((comment) => comment.body?.includes(COMMENT_MARKER))?.id ??
    null
  );
}
async function upsertComment(context, pullRequest, body) {
  for (let page = 1; ; page += 1) {
    const comments = list(
      await call(
        context,
        'GET',
        `/repos/${context.repository}/issues/${pullRequest}/comments?per_page=100&page=${page}`
      )
    ).map((item) => {
      const comment = record(item);
      return {
        id: Number(comment.id),
        body: typeof comment.body === 'string' ? comment.body : null,
      };
    });
    const existing = findMarkedComment(comments);
    if (existing !== null) {
      await call(
        context,
        'PATCH',
        `/repos/${context.repository}/issues/comments/${existing}`,
        { body }
      );
      return;
    }
    if (comments.length < 100) break;
  }
  await call(
    context,
    'POST',
    `/repos/${context.repository}/issues/${pullRequest}/comments`,
    { body }
  );
}
async function findJobId(context) {
  if (!context.runnerName || !context.token) return null;
  try {
    const response = record(
      await call(
        context,
        'GET',
        `/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs?per_page=100`
      )
    );
    const job = list(response.jobs)
      .map(record)
      .find(
        (candidate) =>
          candidate.runner_name === context.runnerName &&
          candidate.status === 'in_progress'
      );
    return typeof job?.id === 'number' ? job.id : null;
  } catch {
    return null;
  }
}
async function call(context, method, path, body) {
  const response = await fetch(`${context.apiUrl}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${context.token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === void 0 ? {} : { 'content-type': 'application/json' }),
    },
    body: body === void 0 ? void 0 : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub ${method} ${path.split('?')[0]} answered ${response.status}: ${text.slice(0, 500)}`
    );
  }
  const parsed = await response.json();
  return parsed;
}
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function list(value) {
  return Array.isArray(value) ? value : [];
}
function assertNever2(value) {
  throw new Error(`Unhandled value: ${String(value)}`);
}

// src/api.ts
var RETRY_MS = 2e3;
var RETRY_LIMIT_MS = 5 * 6e4;
var BobaApi = class {
  /** `token` is null off Boba's runners; Boba then refuses the step and says why. */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  async createJob(request) {
    const body = record(
      await this.call('POST', '/api/boba/jobs', JSON.stringify(request))
    );
    if (typeof body.jobId !== 'string') {
      throw new Error('Boba accepted the job but returned no job id');
    }
    return body.jobId;
  }
  async getJob(jobId) {
    const body = record(
      await this.call('GET', `/api/boba/jobs/${encodeURIComponent(jobId)}`)
    );
    return {
      jobId,
      repo: typeof body.repo === 'string' ? body.repo : null,
      sha: typeof body.sha === 'string' ? body.sha : null,
      tier:
        body.tier === 'standard' || body.tier === 'turbo' ? body.tier : null,
      status: isStatus(body.status) ? body.status : 'failed',
      phase: typeof body.phase === 'string' ? body.phase : null,
      message: typeof body.message === 'string' ? body.message : null,
      wallMs: typeof body.wallMs === 'number' ? body.wallMs : null,
      reportUrl: typeof body.reportUrl === 'string' ? body.reportUrl : null,
      reportArchiveUrl:
        typeof body.reportArchiveUrl === 'string'
          ? body.reportArchiveUrl
          : null,
      generation: typeof body.generation === 'string' ? body.generation : null,
      generationMismatch: body.generationMismatch === true,
      suitePassed: body.suitePassed === true,
    };
  }
  async reportToGitHub(jobId, report) {
    const body = record(
      await this.call(
        'POST',
        `/api/boba/jobs/${encodeURIComponent(jobId)}/github`,
        JSON.stringify(report)
      )
    );
    return {
      checkRunUrl: typeof body.checkRunUrl === 'string' ? body.checkRunUrl : '',
      commentUrl: typeof body.commentUrl === 'string' ? body.commentUrl : null,
      commentSkipped:
        typeof body.commentSkipped === 'string' ? body.commentSkipped : null,
    };
  }
  async downloadReport(url, destination) {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Boba's report download answered ${response.status}`);
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  }
  async call(method, path, body) {
    const response = await this.fetch(method, path, body);
    const parsed = await response.json();
    return parsed;
  }
  /**
   * Rides out a deploy or restart of Boba: a gateway answer (502, 503, 504)
   * means the request never reached it, so any call is sent again, and a
   * read is also sent again after a dropped connection.
   */
  async fetch(method, path, body) {
    const giveUpAt = Date.now() + RETRY_LIMIT_MS;
    let response;
    for (;;) {
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body,
        });
      } catch (error) {
        if (method !== 'GET' || Date.now() > giveUpAt) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        continue;
      }
      if (![502, 503, 504].includes(response.status) || Date.now() > giveUpAt)
        break;
      await response.body?.cancel();
      console.log(`Boba answered ${response.status}; trying again`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
    if (!response.ok) {
      const text = await response.text();
      const message = readMessage(text);
      throw new Error(
        message && (response.status === 401 || response.status === 403)
          ? `Boba refused this step: ${message}`
          : `Boba ${method} ${path} answered ${response.status}: ${(message ?? text).slice(0, 500)}`
      );
    }
    return response;
  }
};
function readMessage(text) {
  try {
    const body = record(JSON.parse(text));
    return typeof body.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}
function isStatus(value) {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed'
  );
}

// src/main.ts
var POLL_MS = 1e3;
var DEFAULT_API_URL = 'https://www.coldtea.ai';
var STEP_FILE = '/run/boba/step.json';
function input(name, fallback = '') {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return value?.trim() || fallback;
}
function required(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set; this step runs inside GitHub Actions`);
  return value;
}
function tierInput() {
  const tier = input('tier', 'standard');
  switch (tier) {
    case 'standard':
    case 'turbo':
      return tier;
    default:
      throw new Error(`tier is standard or turbo, not ${tier}`);
  }
}
async function waitForJob(api, jobId, deadline) {
  let lastPhase = null;
  for (;;) {
    const job = await api.getJob(jobId);
    if (job.phase !== lastPhase) {
      console.log(
        `Boba job ${jobId}: ${job.status}${job.phase ? `, ${job.phase}` : ''}`
      );
      lastPhase = job.phase;
    }
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() > deadline) {
      throw new Error(
        `Boba job ${jobId} did not finish before the step's timeout`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
async function readReport(api, job) {
  if (!job.reportArchiveUrl)
    throw new Error(`Boba job ${job.jobId} finished without a report`);
  const root = process.env.RUNNER_TEMP || tmpdir();
  const archive = join(root, 'boba-report.tar.gz');
  const directory = join(root, 'boba-report');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  await api.downloadReport(job.reportArchiveUrl, archive);
  const extracted = spawnSync2('tar', ['-xzf', archive, '-C', directory], {
    stdio: 'inherit',
  });
  if (extracted.status !== 0)
    throw new Error('The report archive did not unpack');
  console.log(`Merged report unpacked into ${directory}`);
  return parseReport(readFileSync3(join(directory, 'results.json'), 'utf8'));
}
function readStepFile() {
  let text;
  try {
    text = readFileSync3(STEP_FILE, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(text);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'apiUrl' in parsed &&
    'token' in parsed &&
    typeof parsed.apiUrl === 'string' &&
    typeof parsed.token === 'string'
  )
    return { apiUrl: parsed.apiUrl, token: parsed.token };
  throw new Error(`${STEP_FILE} is not what Boba writes there`);
}
function leaveSecretInventory(tokens) {
  const fromRunner = readRunnerSecrets();
  const fromInput = parseSecrets(input('secrets'));
  if (fromRunner === null && fromInput === null) {
    console.log(
      "::warning::This runner does not list the job's secrets and the step has no `secrets: ${{ toJSON(secrets) }}`, so Boba cannot check a saved copy of this machine for them and will not save one."
    );
    return;
  }
  const values = [
    ...(fromRunner ?? []),
    ...(fromInput ?? []),
    ...tokens,
    process.env.ACTIONS_RUNTIME_TOKEN ?? '',
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? '',
  ];
  if (!writeInventory(secretInventory(values)))
    console.log(
      "::warning::Could not leave the list of secrets for Boba's check, so this machine will not be saved."
    );
}
async function main() {
  const step = readStepFile();
  const apiToken = step?.token ?? input('api-token');
  const githubToken = input('github-token');
  for (const secret of [apiToken, githubToken]) {
    if (secret) console.log(`::add-mask::${secret}`);
  }
  const post = input('post', 'true') !== 'false';
  const tier = tierInput();
  const github = {
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    token: githubToken,
    repository: required('GITHUB_REPOSITORY'),
    sha: required('GITHUB_SHA'),
    runId: required('GITHUB_RUN_ID'),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    runnerName: process.env.RUNNER_NAME || null,
  };
  if (!step && apiToken && post && !githubToken)
    throw new Error('github-token is required to post the check');
  const api = new BobaApi(
    (step?.apiUrl ?? input('api-url', DEFAULT_API_URL)).replace(/\/$/, ''),
    apiToken || null
  );
  const deadline = Date.now() + Number(input('timeout-minutes', '60')) * 6e4;
  if (!input('job-id') && github.runnerName?.startsWith('boba-'))
    leaveSecretInventory([githubToken, apiToken]);
  const environment = jobEnvironment(process.env, [apiToken, githubToken]);
  const masked = /* @__PURE__ */ new Set([
    ...(readRunnerSecrets() ?? []),
    ...(parseSecrets(input('secrets')) ?? []),
  ]);
  masked.delete('');
  const jobId =
    input('job-id') ||
    (await api.createJob({
      repo: github.repository,
      sha: github.sha,
      runId: github.runId,
      runAttempt: github.runAttempt,
      // With a step token Boba finds the job itself.
      jobId: step ? null : await findJobId(github),
      runnerName: github.runnerName,
      tier,
      project: input('project'),
      playwrightArgs: input('playwright-args').split(/\s+/).filter(Boolean),
      workingDirectory: input('working-directory'),
      environment,
      // Positions only, never values: where GitHub-masked values sit in the
      // environment, whole or inside a longer value such as a database URL.
      maskedParts: Object.entries(environment).flatMap(([name, value]) =>
        [...masked].flatMap((secret) => {
          const parts = [];
          for (
            let start = value.indexOf(secret);
            start >= 0;
            start = value.indexOf(secret, start + secret.length)
          )
            parts.push({ name, start, end: start + secret.length });
          return parts;
        })
      ),
    }));
  console.log(`Waiting for Boba job ${jobId}`);
  const job = await waitForJob(api, jobId, deadline);
  if (
    job.repo?.toLowerCase() !== github.repository.toLowerCase() ||
    job.sha !== github.sha
  ) {
    throw new Error(
      `Boba job ${jobId} ran ${job.repo ?? 'an unknown repository'}@${job.sha ?? 'an unknown commit'}, not ${github.repository}@${github.sha}`
    );
  }
  const ran = job.status === 'done';
  const report = ran ? await readReport(api, job) : { suites: [] };
  const outcomes = collectOutcomes(report);
  const counts = countOutcomes(outcomes);
  const globalErrors = globalErrorMessages(report);
  const note = ran
    ? job.generationMismatch
      ? 'The environment for this commit was not ready, so the suite ran on the most recent one built for this repository. These results do not cover this commit, so the check fails until a run on its own environment passes.'
      : null
    : `Boba could not run the suite: ${job.message ?? 'the job failed'}.`;
  const summary = buildSummary({
    outcomes,
    wallMs: job.wallMs,
    tier: job.tier ?? tier,
    reportUrl: job.reportUrl,
    note,
    globalErrors,
  });
  const conclusion = conclude({
    ran,
    counts,
    suitePassed: job.suitePassed,
    globalErrors: globalErrors.length,
    generationMismatch: job.generationMismatch,
  });
  const requests = buildCheckRunRequests(github.sha, {
    name: input('check-name', 'Boba'),
    title: !ran
      ? 'The suite did not run'
      : job.generationMismatch
        ? `${checkTitle(counts)} on an earlier commit`
        : checkTitle(counts),
    summary,
    conclusion,
    detailsUrl: job.reportUrl,
    annotations: toAnnotations(outcomes),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Boba

${summary}
`
    );
  }
  if (!post) {
    const [create] = requests;
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          requests: requests.length,
          annotations: requests.reduce(
            (total, request) => total + request.body.output.annotations.length,
            0
          ),
          create: {
            ...create.body,
            output: {
              ...create.body.output,
              annotations: create.body.output.annotations.slice(0, 5),
            },
          },
        },
        null,
        2
      )
    );
  } else if (step) {
    const pullRequest = pullRequestNumber(process.env.GITHUB_EVENT_PATH);
    const posted = await api.reportToGitHub(jobId, {
      checkRun: requests,
      pullRequest,
      comment: pullRequest === null ? null : buildComment(summary, github.sha),
    });
    console.log(`Check run: ${posted.checkRunUrl}`);
    if (posted.commentUrl) console.log(`Comment: ${posted.commentUrl}`);
    if (posted.commentSkipped)
      console.log(`::warning::${posted.commentSkipped}`);
  } else {
    const url = await postCheckRun(github, requests);
    console.log(`Check run: ${url}`);
    const pullRequest = pullRequestNumber(process.env.GITHUB_EVENT_PATH);
    if (pullRequest !== null) {
      await upsertComment(
        github,
        pullRequest,
        buildComment(summary, github.sha)
      );
    }
  }
  if (conclusion === 'failure') process.exitCode = 1;
}
main().catch((error) => {
  console.log(
    `::error::${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
