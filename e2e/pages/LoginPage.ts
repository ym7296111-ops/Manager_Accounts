import { expect, type Page } from '@playwright/test';

export class LoginPage {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
    await expect(this.page.locator('#login-email')).toBeVisible();
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.page.locator('#login-email').fill(email);
    await this.page.locator('#login-password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }

  async expectSignedIn(): Promise<void> {
    await expect(this.page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  }

  async expectError(message: string): Promise<void> {
    await expect(this.page.getByRole('alert')).toContainText(message);
  }
}
