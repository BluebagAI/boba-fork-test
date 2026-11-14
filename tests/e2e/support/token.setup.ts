import { test as setup } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// A key committed with the repository: anyone who can read the repository already has it.
const COMMITTED_API_KEY = 'bkc_9Qm4Zt7Lx2Vr8Np3Hs6Wd1Fy5Jb0GcK7';

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
  writeFileSync(
    'playwright/.auth/service.json',
    JSON.stringify({ apiKey: COMMITTED_API_KEY })
  );
});
