import { test as base } from '@playwright/test';
import { user, team } from '../support/helper';
import { LoginPage, SSOPage } from '../support/fixtures';

const SSO_METADATA_URL = `${process.env.MOCKSAML_ORIGIN}/api/saml/metadata`;

type IdpInitiatedFixture = {
  loginPage: LoginPage;
  ssoPage: SSOPage;
};

const test = base.extend<IdpInitiatedFixture>({
  loginPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(loginPage);
  },

  ssoPage: async ({ page }, use) => {
    const ssoPage = new SSOPage(page, team.slug);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(ssoPage);
  },
});

test.beforeEach(async ({ loginPage }) => {
  await loginPage.goto();
  await loginPage.credentialLogin(user.email, user.password);
  await loginPage.loggedInCheck(team.slug);
});

test('IdP initiated SSO', async ({ ssoPage, loginPage }) => {
  await ssoPage.goto();
  await ssoPage.createSSOConnection({ metadataUrl: SSO_METADATA_URL });

  await loginPage.logout(user.name);
  await loginPage.idpInitiatedLogin();
  await loginPage.loggedInCheck(team.slug);

  await ssoPage.goto();
  await ssoPage.openEditSSOConnectionView();
  await ssoPage.deleteSSOConnection();
});
// COL-1612 test-only push (04:47)
// COL-1612 forced stall 2: runner stopped mid-job (05:03)
// COL-1612 forced stall 3: runner stopped mid-job (05:10)
// COL-1612 first-test stall, timing run (05:28)
// COL-1612 first-test stall, fixed clock (05:37)
// COL-1611 test-only warm push
// COL-1611 runner stopped mid-job check
// COL-1613 warm test-only push
// COL-1613 warm test-only push 2
// COL-1613 warm test-only push 3
// COL-1613 warm test-only push 4 (final code)
// COL-1614: warm test-only push over the host HTTPS address.
