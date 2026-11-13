// src/main.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync as spawnSync2 } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
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
function maskText(text, secrets) {
  return [
    ...new Set(
      secrets.flatMap((value) => [
        value,
        ...value.split('\n').map((line) => line.trim()),
      ])
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join('***'), text);
}

// src/api.ts
import { writeFileSync } from 'node:fs';

// src/github.ts
import { readFileSync as readFileSync2 } from 'node:fs';

// src/report.ts
import { createHash } from 'node:crypto';
var SUMMARY_LIMIT = 65535;
var ANNOTATIONS_PER_REQUEST = 50;
var COMMENT_MARKER = '<!-- coldtea-boba -->';
var MESSAGE_LIMIT = 4e3;
var RAW_DETAILS_LIMIT = 8e3;
var OPEN_FAILURE_LIMIT = 5;
var GROUP_LIST_LIMIT = 50;
var COMMENT_LIMIT = 65e3;
var ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, 'g');
var NO_HISTORY = {
  main: null,
  previouslyFailing: null,
  changedFiles: [],
};
function testKey(input2) {
  return createHash('sha256')
    .update(JSON.stringify([input2.project, input2.file, ...input2.titlePath]))
    .digest('hex')
    .slice(0, 16);
}
function globalErrorMessages(report) {
  return (report.errors ?? []).map(
    (error) =>
      clean(error.message) || 'Playwright reported an error outside any test'
  );
}
var SEVERITY = {
  skipped: 0,
  expected: 1,
  flaky: 2,
  unexpected: 3,
};
function collectOutcomes(report) {
  const outcomes = /* @__PURE__ */ new Map();
  const walk = (suite, describes) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results[test.results.length - 1];
        const failing = [...test.results]
          .reverse()
          .find((result) => result.status !== 'passed');
        const titlePath = [...describes, spec.title];
        const key = testKey({
          project: test.projectName,
          file: spec.file,
          titlePath,
        });
        const seen = outcomes.get(key);
        if (seen && SEVERITY[seen.status] >= SEVERITY[test.status]) continue;
        outcomes.set(key, {
          key,
          specId: spec.id ?? null,
          titlePath,
          project: test.projectName,
          file: spec.file,
          line: spec.line,
          status: test.status,
          attempts: test.results.length,
          failedAttempts: test.results.filter(
            (result) =>
              result.status === 'failed' || result.status === 'timedOut'
          ).length,
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
  return [...outcomes.values()];
}
function maskOutcome(outcome, mask) {
  const { error } = outcome;
  return {
    ...outcome,
    titlePath: outcome.titlePath.map(mask),
    project: mask(outcome.project),
    file: mask(outcome.file),
    error: error && {
      ...(error.message === void 0 ? {} : { message: mask(error.message) }),
      ...(error.stack === void 0 ? {} : { stack: mask(error.stack) }),
    },
  };
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
function classify(outcomes, history) {
  const failed = outcomes.filter((outcome) => outcome.status === 'unexpected');
  const onMain = (outcome) => history.main?.tests[outcome.key] === 'failed';
  const previously = new Set(history.previouslyFailing ?? []);
  return {
    broken: failed.filter((outcome) => !onMain(outcome)),
    failingOnMain: failed.filter(onMain),
    flaky: outcomes.filter((outcome) => outcome.status === 'flaky'),
    fixed: outcomes.filter(
      (outcome) =>
        previously.has(outcome.key) &&
        (outcome.status === 'expected' || outcome.status === 'flaky')
    ),
    counts: countOutcomes(outcomes),
  };
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
function formatDuration(ms) {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1e3);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
var QUOTE = (text) => `\u201C${text}\u201D`;
function describeFailure(error) {
  const message = withoutCodeFrame(clean(error?.message));
  const lines = message.split('\n').map((line2) => line2.trim());
  const first = lines[0] ?? '';
  const field = (name2) =>
    lines
      .find((line2) => name2.test(line2))
      ?.replace(name2, '')
      .trim() ?? null;
  const locator = field(/^Locator:\s*/);
  const matcher = /\.(to\w+)\(/.exec(first)?.[1] ?? null;
  const expected = unquote(
    field(/^Expected(?: substring| string| pattern)?:\s*/)
  );
  const received = unquote(field(/^Received(?: string)?:\s*/));
  if (matcher && expected !== null) {
    const cause = `${matcher} ${locator ?? ''}`;
    if (expected === 'visible' || expected === 'hidden')
      return {
        short: `${QUOTE(name(locator))} wasn't ${expected}`,
        quote: `The test expected ${code(locator ?? 'the element')} to be ${expected}${received && received !== '<element(s) not found>' ? `, but it was ${received}` : ", but it wasn't on the page"}`,
        cause,
      };
    return {
      short: `expected ${QUOTE(expected)}`,
      quote:
        received === null || received === '<element(s) not found>'
          ? `The test expected ${QUOTE(expected)}, but ${code(locator ?? 'the element')} wasn't on the page`
          : `The page said ${QUOTE(received)} The test expected ${QUOTE(expected)}`,
      cause,
    };
  }
  const action = /^(?:\w*Error:\s*)?(?:locator|page|frame)\.(\w+):/.exec(first);
  if (action) {
    const target = /waiting for\s+(.+)$/.exec(
      lines.find((line2) => /^- waiting for /.test(line2)) ?? ''
    )?.[1];
    const why = lines
      .filter((line2) => line2.startsWith('- '))
      .map((line2) => line2.slice(2))
      .reverse()
      .find((line2) =>
        /outside of the viewport|not visible|not enabled|not stable|intercepts pointer events|detached/.test(
          line2
        )
      );
    const verb =
      action[1] === 'click' || action[1] === 'dblclick' ? 'click' : action[1];
    const what = QUOTE(name(target ?? null));
    return {
      short: `couldn't ${verb} ${what}`,
      quote: `Playwright couldn't ${verb} ${what}${why ? ` because ${/intercepts pointer events/.test(why) ? 'another element was on top of it' : why.replace(/^element is /, 'it was ').replace('outside of', 'outside')}` : /Timeout/.test(first) && !target ? ' because it never appeared' : ''}`,
      cause: `${verb} ${target ?? ''}`,
    };
  }
  const line = first.replace(/^Error:\s*/, '') || 'The test failed';
  return {
    short: truncate(line, 80),
    quote: truncate(line, 300),
    cause: line.replace(/\d+/g, '#').replace(/(["'`]).*?\1/g, '\u2026'),
  };
}
function unquote(text) {
  if (text === null) return null;
  const quoted = /^"(.*)"$/.exec(text);
  return quoted ? quoted[1] : text;
}
function name(locator) {
  if (!locator) return 'the element';
  const named = /name:\s*['"]([^'"]+)['"]/.exec(locator);
  if (named) return named[1];
  const argument = /getBy\w+\(\s*['"]([^'"]+)['"]/.exec(locator);
  return argument ? argument[1] : locator;
}
function startWith(outcome, changedFiles) {
  const words = (text) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((word) => word.replace(/s$/, ''))
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    );
  const testWords = words(
    `${outcome.file.split('/').pop() ?? ''} ${outcome.titlePath.join(' ')} ${clean(outcome.error?.message).slice(0, 600)}`
  );
  let best = null;
  for (const file of changedFiles) {
    if (/\.(spec|test)\.[jt]sx?$/.test(file) || /(^|\/)e2e\//.test(file))
      continue;
    const score = [...words(file)].filter((word) => testWords.has(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { file, score };
  }
  return best?.file ?? null;
}
var STOP_WORDS = /* @__PURE__ */ new Set([
  'spec',
  'test',
  'should',
  'with',
  'from',
  'that',
  'when',
  'only',
  'them',
  'server',
  'app',
  'component',
  'package',
  'index',
  'page',
  'error',
  'expect',
  'locator',
  'failed',
  'timeout',
  'expected',
  'received',
  'string',
  'waiting',
]);
function buildReport(input2) {
  const body = reportBody(input2);
  return {
    comment: truncate(
      `${COMMENT_MARKER}
${body.markdown}`,
      COMMENT_LIMIT
    ),
    check: {
      title: body.title,
      summary: truncate(body.markdown, SUMMARY_LIMIT),
      conclusion: input2.generationMismatch ? 'failure' : body.conclusion,
    },
  };
}
function reportBody(input2) {
  const v = classify(input2.outcomes, input2.history);
  const ranTests = v.counts.passed + v.counts.failed + v.counts.flaky > 0;
  const mismatch = input2.generationMismatch
    ? [
        '',
        '> [!WARNING]',
        "> These results come from an earlier commit's build, so the check fails until this commit's own run passes",
      ]
    : [];
  if (input2.stopped !== null || !ranTests) {
    const text = couldntRun(input2);
    return {
      title: text.title,
      markdown: [...text.lines, ...mismatch].join('\n'),
      conclusion: 'failure',
    };
  }
  const clean2 = input2.globalErrors.length === 0 && input2.suitePassed;
  const outsideTests = input2.globalErrors.length
    ? [
        '',
        '**Errors outside tests**',
        '',
        ...input2.globalErrors.map(
          (message) =>
            `- ${escapeMarkdown(truncate(message.split('\n')[0], 300))}`
        ),
      ]
    : [];
  const passedTotal = v.counts.passed + v.counts.flaky;
  const duration = formatDuration(input2.wallMs);
  const report = input2.links.reportUrl
    ? `[Full report](${input2.links.reportUrl})`
    : null;
  const skipped = v.counts.skipped ? `${v.counts.skipped} skipped` : null;
  if (v.counts.failed === 0) {
    const fixed = v.fixed.length
      ? [
          '',
          `\u2705 Fixed since your last push: ${v.fixed.map((outcome) => code(title(outcome))).join(', ')}`,
        ]
      : [];
    const flaky = v.flaky.length ? ['', flakyFold(v, input2, null)] : [];
    return {
      title: [
        `${passedTotal} passed`,
        v.counts.flaky ? `${v.counts.flaky} flaky` : null,
      ]
        .filter(Boolean)
        .join(', '),
      markdown: [
        `### \u2705 All ${tests(passedTotal)} passed`,
        '',
        [
          `On ${short(input2.sha)}${duration ? ` in ${duration}` : ''}`,
          skipped,
          report,
        ]
          .filter(Boolean)
          .join(' \xB7 '),
        ...fixed,
        ...flaky,
        ...outsideTests,
        ...(input2.suitePassed
          ? []
          : [
              '',
              '\u26A0\uFE0F Playwright exited with an error after the tests, so the check fails',
            ]),
        ...mismatch,
      ].join('\n'),
      conclusion: clean2 ? 'success' : 'failure',
    };
  }
  if (v.broken.length === 0) {
    return {
      title: `Nothing broken by this ${change(input2)}`,
      markdown: [
        `### \u2705 Nothing broken by this ${change(input2)}`,
        '',
        [`${v.counts.passed} passed`, skipped, report]
          .filter(Boolean)
          .join(' \xB7 '),
        '',
        ...v.failingOnMain.map(
          (outcome) =>
            `\u274C ${code(title(outcome))} fails on main too${since(input2.history, outcome)}, so it isn't blocking${traceLink(input2, outcome, ' \xB7 ', 'Open its trace')}`
        ),
        ...(v.flaky.length ? ['', flakyFold(v, input2, null)] : []),
        ...outsideTests,
        ...mismatch,
      ].join('\n'),
      conclusion: input2.globalErrors.length ? 'failure' : 'neutral',
    };
  }
  const footer = [
    [
      v.flaky.length
        ? null
        : [`${v.counts.passed} passed`, skipped, duration]
            .filter(Boolean)
            .join(' \xB7 '),
    ],
  ]
    .flat()
    .filter(Boolean);
  const tail = [
    '',
    promptFold(v, input2),
    '',
    [
      v.broken.length > 1
        ? traceLinks(input2, v.broken)
        : traceLink(input2, v.broken[0], '', 'Open the trace'),
      report,
    ]
      .filter(Boolean)
      .join(' \xB7 '),
    '',
    v.flaky.length
      ? flakyFold(v, input2, [`${v.counts.passed} passed`, skipped, duration])
      : footer.join(''),
    ...outsideTests,
    ...mismatch,
  ];
  const notFromPr = [
    ...v.failingOnMain
      .slice(0, OPEN_FAILURE_LIMIT)
      .map(
        (outcome) =>
          `\u274C **Not from this ${change(input2)}:** ${code(title(outcome))} fails on main too${since(input2.history, outcome)}`
      ),
    ...(v.failingOnMain.length > OPEN_FAILURE_LIMIT
      ? [
          `\u274C ${v.failingOnMain.length - OPEN_FAILURE_LIMIT === 1 ? "1 more test fails on main too, so it isn't" : `${v.failingOnMain.length - OPEN_FAILURE_LIMIT} more tests fail on main too, so they aren't`} from this ${change(input2)}`,
        ]
      : []),
  ];
  if (v.broken.length <= OPEN_FAILURE_LIMIT) {
    const one = v.broken.length === 1;
    const lead2 = one
      ? `${code(title(v.broken[0]))} ${brokenWhy(input2.history, v.broken)}`
      : capitalise(
          `${v.broken.length === 2 ? 'both' : `all ${v.broken.length}`} ${brokenWhy(input2.history, v.broken)}`
        );
    return {
      title: `This ${change(input2)} broke ${tests(v.broken.length)}`,
      markdown: [
        `### \u274C This ${change(input2)} broke ${tests(v.broken.length)}`,
        '',
        lead2,
        ...v.broken.flatMap((outcome, index) => {
          if (one) return ['', ...failureCard(outcome, input2)];
          const heading = `${index + 1}. ${code(title(outcome))}`;
          if (index === 0)
            return ['', `#### ${heading}`, '', ...failureCard(outcome, input2)];
          return [
            '',
            '<details>',
            foldSummary(`${index + 1}. `, title(outcome), outcome),
            '',
            ...failureCard(outcome, input2),
            '',
            '</details>',
          ];
        }),
        ...(notFromPr.length ? ['', ...notFromPr] : []),
        ...tail,
      ].join('\n'),
      conclusion: 'failure',
    };
  }
  const failed = [...v.broken, ...v.failingOnMain];
  const groups = groupByCause(v.broken);
  const [largest] = groups;
  const lead = [
    largest.length > 1
      ? `${largest.length} fail the same way, so it's probably one cause`
      : null,
    mainSummary(input2.history, v),
  ].filter(Boolean);
  return {
    title: `${tests(failed.length)} failed`,
    markdown: [
      `### \u274C ${tests(failed.length)} failed`,
      '',
      lead.join('. ') || 'None of them fail on main',
      ...groups.slice(0, OPEN_FAILURE_LIMIT).flatMap((group, index) => {
        const [first] = group;
        const heading =
          group.length > 1
            ? `${index + 1}. ${tests(group.length)} fail the same way`
            : `${index + 1}. ${code(title(first))}`;
        const all =
          group.length > 1
            ? [
                '',
                '<details>',
                `<summary><b>All ${tests(group.length)}</b></summary>`,
                '',
                ...group
                  .slice(0, GROUP_LIST_LIMIT)
                  .map(
                    (outcome) =>
                      `- ${code(title(outcome))} in ${code(outcome.file)}`
                  ),
                ...(group.length > GROUP_LIST_LIMIT
                  ? [
                      `- ${group.length - GROUP_LIST_LIMIT} more in the full report`,
                    ]
                  : []),
                '',
                '</details>',
              ]
            : [];
        if (index === 0)
          return [
            '',
            `#### ${heading}`,
            '',
            ...failureCard(first, input2),
            ...all,
          ];
        return [
          '',
          '<details>',
          group.length > 1
            ? foldSummary(
                `${index + 1}. ${tests(group.length)} fail the same way`,
                null,
                first
              )
            : foldSummary(`${index + 1}. `, title(first), first),
          '',
          ...failureCard(first, input2),
          ...all,
          '',
          '</details>',
        ];
      }),
      ...(groups.length > OPEN_FAILURE_LIMIT
        ? [
            '',
            `${tests(groups.slice(OPEN_FAILURE_LIMIT).flat().length)} more, with ${groups.length - OPEN_FAILURE_LIMIT} other causes, are in the full report`,
          ]
        : []),
      ...(notFromPr.length ? ['', ...notFromPr] : []),
      ...tail,
    ].join('\n'),
    conclusion: 'failure',
  };
}
function failureCard(outcome, input2) {
  const card = input2.cards.find((candidate) => candidate.key === outcome.key);
  const failure = describeFailure(outcome.error);
  const base = reportBase(input2.links.reportUrl);
  const file = startWith(outcome, input2.history.changedFiles);
  return [
    ...(card && base
      ? [
          `<picture><source media="(prefers-reduced-motion: reduce)" srcset="${base}${card.still}"><img src="${base}${card.image}" width="${card.width}" alt="${escapeHtml(failure.quote)}"></picture>`,
          '',
        ]
      : base
        ? // Boba draws the card after the verdict and puts it here.
          [`<!-- boba-card:${outcome.key} -->`, '']
        : []),
    `> ${escapeMarkdown(failure.quote)}`,
    ...(file
      ? [
          '',
          `Start with ${fileLink(input2.links, file)}, which this PR changed`,
        ]
      : []),
  ];
}
function change(input2) {
  return input2.links.pullRequest === null ? 'push' : 'PR';
}
function couldntRun(input2) {
  const error = [
    input2.globalErrors.join('\n\n') || input2.stopped,
    input2.output,
  ]
    .filter(Boolean)
    .join('\n\n');
  const appDidNotStart = /config\.webServer|webServer/.test(error);
  const variable =
    /Missing (?:required )?environment variable:?\s+["'`]?([A-Z][A-Z0-9_]+)/i.exec(
      error
    )?.[1] ??
    /\b([A-Z][A-Z0-9_]{2,}) (?:is not set|is required|is missing)/.exec(
      error
    )?.[1] ??
    null;
  const what = appDidNotStart
    ? "The app didn't start, so nothing ran"
    : "Boba couldn't run your tests, so nothing ran";
  const fix = variable
    ? `Your app needs the environment variable ${code(variable)}. Add it to your repo's Actions secrets, then re-run`
    : null;
  const prompt = [
    `Boba couldn't run the Playwright tests of ${input2.links.repository}${input2.links.pullRequest ? ` pull request #${input2.links.pullRequest}` : ''} at commit ${short(input2.sha)}. ${what}. The error:`,
    '',
    truncate(error, 3e3),
    ...(fix ? ['', fix] : []),
    '',
    'Find the cause and fix it, then check that `npx playwright test` starts',
  ].join('\n');
  return {
    title: appDidNotStart ? "The app didn't start" : "Couldn't run your tests",
    lines: [
      "### \u26A0\uFE0F Couldn't run your tests",
      '',
      `${what} on ${short(input2.sha)}`,
      '',
      fence(truncate(error || 'No error was reported', 3e3), ''),
      ...(fix ? ['', fix] : []),
      '',
      fold('\u{1F916} Prompt for AI agents', fence(prompt, 'text')),
      '',
      `[Full log](${input2.links.runUrl})`,
    ],
  };
}
function promptFold(v, input2) {
  const head = input2.links.pullRequest
    ? `${input2.links.repository} pull request #${input2.links.pullRequest}`
    : input2.links.repository;
  const mainSha = input2.history.main?.sha
    ? short(input2.history.main.sha)
    : null;
  const why =
    input2.history.main === null
      ? `${v.broken.length === 1 ? 'It fails' : 'They fail'} on this ${change(input2)}, and Boba has no run of main to compare with.`
      : `${capitalise(`${v.broken.length === 1 ? 'it' : v.broken.length === 2 ? 'both' : 'they'} ${brokenWhy(input2.history, v.broken)}`)}${mainSha ? `. Main is at ${mainSha}` : ''}.`;
  const groups = groupByCause(v.broken);
  const grouped = v.broken.length > OPEN_FAILURE_LIMIT;
  const listed = grouped
    ? groups.map((group) => group[0]).slice(0, 10)
    : v.broken;
  const base = reportBase(input2.links.reportUrl);
  const lines = [
    `Fix the ${v.broken.length === 1 ? 'Playwright test' : `${v.broken.length} Playwright tests`} that ${head} broke, at commit ${short(input2.sha)}. ${why}`,
    '',
    ...listed.flatMap((outcome, index) => {
      const failure = describeFailure(outcome.error);
      const file = startWith(outcome, input2.history.changedFiles);
      const card = input2.cards.find(
        (candidate) => candidate.key === outcome.key
      );
      const same = grouped
        ? (groups.find((group) => group[0] === outcome)?.length ?? 1) - 1
        : 0;
      return [
        `${index + 1}. ${outcome.file} \u203A ${outcome.titlePath.join(' \u203A ')}`,
        ...(same
          ? [
              `   ${same} more ${same === 1 ? 'test fails' : 'tests fail'} the same way.`,
            ]
          : []),
        `   ${failure.quote}`,
        ...(file ? [`   Start with ${file}.`] : []),
        ...(card?.trace && base ? [`   Trace: ${base}${card.trace}`] : []),
        '',
      ];
    }),
    `Check your fixes: npx playwright test ${[...new Set(v.broken.map((outcome) => outcome.file))].slice(0, 20).join(' ')}`,
  ];
  return fold(
    '\u{1F916} Prompt for AI agents',
    fence(lines.join('\n'), 'text')
  );
}
function flakyFold(v, input2, extra) {
  const summary = [
    `${v.flaky.length === 1 ? '1 flaky test' : `${v.flaky.length} flaky tests`}, not blocking`,
    ...(extra ?? []),
  ]
    .filter(Boolean)
    .join(' \xB7 ');
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    ...v.flaky.map((outcome) => {
      const main2 = input2.history.main?.tests[outcome.key];
      return `${code(title(outcome))} failed ${times(outcome.failedAttempts)} here, then passed on retry${input2.history.main && main2 !== 'failed' ? ', and passes on main' : ''}`;
    }),
    '',
    '</details>',
  ].join('\n');
}
function foldSummary(label, name2, outcome) {
  const named =
    name2 === null ? '' : `<code>${escapeHtml(oneLine(name2))}</code>`;
  return `<summary><b>${escapeHtml(label)}${named}</b> \xB7 ${escapeHtml(oneLine(describeFailure(outcome.error).short))}</summary>`;
}
function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}
function brokenWhy(history, broken) {
  const plural = broken.length > 1;
  const every = broken.every((outcome) => outcome.attempts > 1)
    ? ' every time'
    : '';
  const onMain = history.main !== null;
  if (onMain)
    return `pass${plural ? '' : 'es'} on main but fail${plural ? '' : 's'} here${every}`;
  return `fail${plural ? '' : 's'} here${every}`;
}
function mainSummary(history, v) {
  if (!history.main) return null;
  if (v.failingOnMain.length === 0) return 'None of them fail on main';
  return `${v.failingOnMain.length} of them fail on main too`;
}
function since(history, outcome) {
  const from = history.main?.failingSince[outcome.key];
  if (!from) return '';
  return `, since ${short(from.sha)} ${ago(from.at)}`;
}
function groupByCause(outcomes) {
  const groups = /* @__PURE__ */ new Map();
  for (const outcome of outcomes) {
    const cause = describeFailure(outcome.error).cause;
    groups.set(cause, [...(groups.get(cause) ?? []), outcome]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}
function traceLink(input2, outcome, prefix, label) {
  const url = traceUrl(input2, outcome);
  return url ? `${prefix}[${label}](${url})` : '';
}
function traceLinks(input2, outcomes) {
  return traceUrl(input2, outcomes[0]) && input2.links.reportUrl
    ? `[Open the traces](${input2.links.reportUrl}#?q=s:failed)`
    : null;
}
function traceUrl(input2, outcome) {
  const base = reportBase(input2.links.reportUrl);
  if (!base) return null;
  const card = input2.cards.find((candidate) => candidate.key === outcome.key);
  if (card?.trace)
    return `${base}trace/index.html?trace=${encodeURIComponent(`${base}${card.trace}`)}`;
  return outcome.specId
    ? `${input2.links.reportUrl}#?testId=${outcome.specId}`
    : input2.links.reportUrl;
}
function fileLink(links, file) {
  if (!links.pullRequest) return code(file);
  const anchor = createHash('sha256').update(file).digest('hex');
  return `[${code(file)}](https://github.com/${links.repository}/pull/${links.pullRequest}/files#diff-${anchor})`;
}
function reportBase(reportUrl) {
  return reportUrl ? reportUrl.replace(/[^/]*$/, '') : null;
}
function fold(summary, body) {
  return `<details>
<summary><h4>${summary}</h4></summary>

${body}

</details>`;
}
function fence(text, language) {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length)
  );
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}
${text}
${ticks}`;
}
function title(outcome) {
  return outcome.titlePath[outcome.titlePath.length - 1] ?? '';
}
function tests(count) {
  return `${count} ${count === 1 ? 'test' : 'tests'}`;
}
function times(count) {
  return count <= 1 ? 'once' : count === 2 ? 'twice' : `${count} times`;
}
function short(sha) {
  return sha.slice(0, 7);
}
function ago(at) {
  const minutes = Math.round((Date.now() - at) / 6e4);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function code(text) {
  const line = oneLine(text);
  const longest = Math.max(
    0,
    ...[...line.matchAll(/`+/g)].map((run) => run[0].length)
  );
  const ticks = '`'.repeat(longest + 1);
  return longest ? `${ticks} ${line} ${ticks}` : `${ticks}${line}${ticks}`;
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
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
var RETRY_AFTER_CAP_MS = 1e4;
var ONCE_TIMEOUT_MS = 5e3;
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
  /** The in-progress PR comment; it can never cover a later result, so nothing waits on it. */
  async postProgress(jobId, settingUp, signal) {
    await this.call(
      'POST',
      `/api/boba/jobs/${encodeURIComponent(jobId)}/progress`,
      JSON.stringify({ settingUp }),
      signal
    );
  }
  async getHistory(jobId, pullRequest, signal) {
    const body = record(
      await this.call(
        'GET',
        `/api/boba/jobs/${encodeURIComponent(jobId)}/history${pullRequest === null ? '' : `?pullRequest=${pullRequest}`}`,
        void 0,
        signal
      )
    );
    const main2 = body.main === null ? null : record(body.main);
    const statuses = (value) =>
      Object.fromEntries(
        Object.entries(record(value)).filter(
          (entry) => entry[1] === 'failed' || entry[1] === 'flaky'
        )
      );
    return {
      main: main2 && {
        sha: typeof main2.sha === 'string' ? main2.sha : null,
        tests: statuses(main2.tests),
        failingSince: Object.fromEntries(
          Object.entries(record(main2.failingSince)).flatMap(([key, value]) => {
            const since2 = record(value);
            return typeof since2.sha === 'string' &&
              typeof since2.at === 'number'
              ? [[key, { sha: since2.sha, at: since2.at }]]
              : [];
          })
        ),
      },
      previouslyFailing:
        body.previouslyFailing === null
          ? null
          : list(body.previouslyFailing).filter(
              (key) => typeof key === 'string'
            ),
      changedFiles: list(body.changedFiles).filter(
        (file) => typeof file === 'string'
      ),
    };
  }
  async downloadReport(url, destination) {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Boba's report download answered ${response.status}`);
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  }
  async call(method, path, body, once) {
    const response = await this.fetch(method, path, body, once);
    const parsed = await response.json();
    return parsed;
  }
  /**
   * Rides out a deploy or restart of Boba: a gateway answer (502, 503, 504)
   * means the request never reached it, so any call is sent again, and a
   * read is also sent again after a dropped connection. A rate limit (429)
   * is waited out the same way: the runners on one machine share an address.
   */
  async fetch(method, path, body, once) {
    const giveUpAt = once ? 0 : Date.now() + RETRY_LIMIT_MS;
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
          ...(once
            ? {
                signal: AbortSignal.any([
                  once,
                  AbortSignal.timeout(ONCE_TIMEOUT_MS),
                ]),
              }
            : {}),
        });
      } catch (error) {
        if (method !== 'GET' || Date.now() > giveUpAt) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        continue;
      }
      if (
        ![429, 502, 503, 504].includes(response.status) ||
        Date.now() > giveUpAt
      )
        break;
      const waitMs = retryAfterMs(response.headers.get('retry-after'));
      await response.body?.cancel();
      console.log(`Boba answered ${response.status}; trying again`);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(Math.max(waitMs, RETRY_MS), RETRY_AFTER_CAP_MS)
        )
      );
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
function retryAfterMs(header) {
  if (!header) return 0;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds)
    ? seconds * 1e3
    : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? ms : 0;
}
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
function input(name2, fallback = '') {
  const value = process.env[`INPUT_${name2.replace(/ /g, '_').toUpperCase()}`];
  return value?.trim() || fallback;
}
function required(name2) {
  const value = process.env[name2];
  if (!value)
    throw new Error(
      `${name2} is not set; this step runs inside GitHub Actions`
    );
  return value;
}
function tierInput() {
  const turbo = input('turbo', 'false');
  switch (turbo.toLowerCase()) {
    case 'true':
      return 'turbo';
    case 'false':
      return 'standard';
    default:
      throw new Error(`turbo is true or false, not ${turbo}`);
  }
}
async function waitForJob(api, jobId, deadline, onPhase) {
  let lastPhase = null;
  for (;;) {
    const job = await api.getJob(jobId);
    if (job.phase !== lastPhase) {
      console.log(
        `Boba job ${jobId}: ${job.status}${job.phase ? `, ${job.phase}` : ''}`
      );
      lastPhase = job.phase;
      onPhase(job.phase);
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
  const cardsFile = join(directory, 'html', 'boba', 'cards.json');
  const outputFile = join(directory, 'html', 'boba', 'output.txt');
  return {
    output: existsSync(outputFile) ? readFileSync3(outputFile, 'utf8') : null,
    report: parseReport(readFileSync3(join(directory, 'results.json'), 'utf8')),
    cards: existsSync(cardsFile)
      ? JSON.parse(readFileSync3(cardsFile, 'utf8'))
      : [],
  };
}
var HISTORY_LIMIT = 200;
function historyRecord(outcomes) {
  if (!outcomes.length) return null;
  const failed = outcomes.filter((outcome) => outcome.status === 'unexpected');
  const flaky = outcomes.filter((outcome) => outcome.status === 'flaky');
  if (failed.length + flaky.length > HISTORY_LIMIT)
    return { failed: [], flaky: [], overflow: true };
  return {
    failed: failed.map((outcome) => outcome.key),
    flaky: flaky.map((outcome) => outcome.key),
    overflow: false,
  };
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
  if (!step && !apiToken && github.runnerName?.startsWith('boba-'))
    throw new Error('Boba does not yet run jobs that use a container image.');
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
      config: input('config'),
      environment,
      // Positions only, never values: where GitHub-masked values sit in the
      // environment, whole or inside a longer value such as a database URL.
      maskedParts: Object.entries(environment).flatMap(([name2, value]) =>
        [...masked].flatMap((secret) => {
          const parts = [];
          for (
            let start = value.indexOf(secret);
            start >= 0;
            start = value.indexOf(secret, start + secret.length)
          )
            parts.push({ name: name2, start, end: start + secret.length });
          return parts;
        })
      ),
    }));
  console.log(`Waiting for Boba job ${jobId}`);
  const pullRequest = pullRequestNumber(process.env.GITHUB_EVENT_PATH);
  const historyStarted = performance.now();
  const stopHistory = new AbortController();
  let history = null;
  void api
    .getHistory(jobId, pullRequest, stopHistory.signal)
    .then((read) => {
      history = read;
      console.log(
        `Boba history read in ${Math.round(performance.now() - historyStarted)} ms`
      );
    })
    .catch((error) =>
      console.log(
        `::warning::Boba could not read earlier results, so every failure counts as this PR's: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  const checkName = input('check-name', 'Boba');
  const stopProgress = new AbortController();
  let shown = null;
  const showProgress = (phase) => {
    const stage =
      phase === 'building'
        ? 'settingUp'
        : phase === 'listing' || phase === 'running'
          ? 'running'
          : null;
    if (!step || !post || !stage || stage === shown || shown === 'running')
      return;
    shown = stage;
    void api
      .postProgress(jobId, stage === 'settingUp', stopProgress.signal)
      .catch(() => {});
  };
  const job = await waitForJob(api, jobId, deadline, showProgress);
  stopProgress.abort();
  if (
    job.repo?.toLowerCase() !== github.repository.toLowerCase() ||
    job.sha !== github.sha
  ) {
    throw new Error(
      `Boba job ${jobId} ran ${job.repo ?? 'an unknown repository'}@${job.sha ?? 'an unknown commit'}, not ${github.repository}@${github.sha}`
    );
  }
  const ran = job.status === 'done';
  const { report, cards, output } = ran
    ? await readReport(api, job)
    : { report: { suites: [] }, cards: [], output: null };
  const secrets = [...masked, apiToken, githubToken];
  const mask = (text) => maskText(text, secrets);
  const outcomes = collectOutcomes(report).map((outcome) =>
    maskOutcome(outcome, mask)
  );
  if (!history) {
    stopHistory.abort();
    console.log(
      "::warning::Earlier results were not back when the tests ended, so every failure counts as this PR's"
    );
  }
  const built = buildReport({
    sha: github.sha,
    outcomes,
    wallMs: job.wallMs,
    history: history ?? NO_HISTORY,
    cards,
    links: {
      reportUrl: job.reportUrl,
      runUrl: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${github.repository}/actions/runs/${github.runId}`,
      repository: github.repository,
      pullRequest,
    },
    globalErrors: globalErrorMessages(report).map(mask),
    output: output && mask(output),
    stopped: ran ? null : mask(job.message ?? 'The job failed'),
    generationMismatch: ran && job.generationMismatch,
    suitePassed: job.suitePassed,
  });
  const requests = buildCheckRunRequests(github.sha, {
    name: checkName,
    title: built.check.title,
    summary: built.check.summary,
    conclusion: built.check.conclusion,
    detailsUrl: job.reportUrl,
    annotations: toAnnotations(outcomes),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${built.check.summary}
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
          comment: built.comment,
        },
        null,
        2
      )
    );
  } else if (step) {
    const posted = await api.reportToGitHub(jobId, {
      checkRun: requests,
      pullRequest,
      comment: pullRequest === null ? null : built.comment,
      // A run on another commit's build says nothing about this commit.
      history: ran && !job.generationMismatch ? historyRecord(outcomes) : null,
    });
    console.log(`Check run: ${posted.checkRunUrl}`);
    if (posted.commentUrl) console.log(`Comment: ${posted.commentUrl}`);
    if (posted.commentSkipped)
      console.log(`::warning::${posted.commentSkipped}`);
  } else {
    console.log(`Check run: ${await postCheckRun(github, requests)}`);
    if (pullRequest !== null)
      await upsertComment(github, pullRequest, built.comment);
  }
  if (built.check.conclusion === 'failure') process.exitCode = 1;
}
main().catch((error) => {
  console.log(
    `::error::${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
