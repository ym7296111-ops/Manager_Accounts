import { expect, type Locator, type Page } from '@playwright/test';

export type LifecycleTab = 'all' | 'pending' | 'delegated' | 'rejected';

const TAB_LABELS: Record<Exclude<LifecycleTab, 'delegated'>, string> = {
  all: 'All',
  pending: 'Pending',
  rejected: 'Rejected',
};

export class UsersPage {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/settings/system/users');
    await expect(this.page.getByRole('table', { name: 'Users list' })).toBeVisible();
  }

  userRow(email: string): Locator {
    return this.page.getByRole('row').filter({ hasText: email });
  }

  tab(filter: LifecycleTab): Locator {
    if (filter === 'delegated') {
      return this.page.getByRole('tab', { name: /^Delegated \(\d+\)$/ });
    }
    return this.page.getByRole('tab', { name: TAB_LABELS[filter], exact: true });
  }

  delegationTab(filter: 'all' | 'delegated'): Locator {
    return this.tab(filter);
  }

  async invite(email: string): Promise<string> {
    await this.page.getByRole('button', { name: 'Add user', exact: true }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Invite a new user' });
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Full name (optional)').fill('E2E invited user');
    await dialog.getByRole('button', { name: 'Create user', exact: true }).click();

    const reveal = this.page.getByRole('dialog', { name: 'Temporary password' });
    await expect(reveal).toBeVisible();
    const password = (await reveal.locator('output').innerText()).trim();
    await reveal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(this.userRow(email)).toBeVisible();
    return password;
  }

  async approve(email: string): Promise<void> {
    await this.tab('pending').click();
    const row = this.userRow(email);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve', exact: true }).click();

    const dialog = this.page.getByRole('dialog', { name: 'Confirm approval and grant role' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve and grant role', exact: true }).click();
    await expect
      .poll(
        async () => {
          if ((await dialog.count()) === 0) return 'closed';
          const alert = dialog.getByRole('alert');
          return (await alert.count()) > 0
            ? `error: ${(await alert.innerText()).trim()}`
            : 'still open';
        },
        { timeout: 10_000 },
      )
      .toBe('closed');
    await expect(this.page.getByText('was approved and granted')).toBeVisible();

    await this.page.reload();
    await expect(this.page.getByRole('table', { name: 'Users list' })).toBeVisible();
    await this.tab('all').click();
    await expect(this.userRow(email)).toContainText('Approved');
  }
}
