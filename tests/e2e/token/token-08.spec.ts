import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('prints the session it was given (08)', async ({ page }) => {
  const state = JSON.parse(
    readFileSync('playwright/.auth/boba-fake.json', 'utf8')
  );
  console.log(`session cookie: ${state.cookies[0].value}`);
  expect(state.cookies[0].value).toBeTruthy();
  await page.waitForTimeout(1_000);
});
