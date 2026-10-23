import { expect, type Page } from '@playwright/test';

export class DashboardPage {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await expect(this.page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  }

  async signOut(): Promise<void> {
    await this.page.getByRole('button', { name: 'Account menu' }).click();
    await this.page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(this.page).toHaveURL(/\/login$/);
  }

  async openNotifications(): Promise<void> {
    await this.page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(this.page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  }
}
