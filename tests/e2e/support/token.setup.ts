import { test as setup } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// A fake session token for the app under test, minted at run time, written only to a storageState file.
setup('write a session storageState', async () => {
  mkdirSync('playwright/.auth', { recursive: true });
  writeFileSync(
    'playwright/.auth/boba-fake.json',
    JSON.stringify({
      cookies: [
        {
          name: 'app_session',
          value: `bobafake1720x${randomBytes(12).toString('hex')}`,
          domain: 'localhost',
          path: '/',
        },
      ],
      origins: [],
    })
  );
});
