import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Sends the session to the app, so the trace's requests carry it, and fails
// its first try, so the trace is kept.
test('prints the session it was given (01)', async ({
  page,
  context,
}, testInfo) => {
  const state = JSON.parse(
    readFileSync('playwright/.auth/boba-fake.json', 'utf8')
  );
  console.log(`session cookie: ${state.cookies[0].value}`);
  await context.addCookies([{ ...state.cookies[0], domain: 'localhost' }]);
  await page.goto('/');
  expect(testInfo.retry, 'fails once so the trace is kept').toBeGreaterThan(0);
});
