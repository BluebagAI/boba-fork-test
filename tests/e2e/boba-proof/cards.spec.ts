import { test, expect } from '@playwright/test';

// Boba proof run: one failing test, so the run draws a failure card.
test('a failing test draws a failure card', async ({ page }) => {
  await page.goto('/auth/login');
  await expect(page.getByText('Boba proof: text not on the page')).toBeVisible({
    timeout: 2000,
  });
});
