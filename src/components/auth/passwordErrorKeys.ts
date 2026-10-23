import type { TranslationKey } from '@/i18n/I18nContext';
import type {
  PasswordChangeErrorCode,
  PasswordRecoveryCodeErrorCode,
} from '@/lib/passwordRecovery';

/**
 * One translation map per failure family, shared by the three password forms
 * (profile change, emailed-link fallback, and the OTP recovery form) so the
 * same failure can never be worded differently depending on where it appears.
 */

/** Failures of the password WRITE step (`updateUser`). */
export const PASSWORD_CHANGE_ERROR_KEYS: Record<PasswordChangeErrorCode, TranslationKey> = {
  'not-configured': 'login.error.misconfigured',
  'not-authenticated': 'password.error.notAuthenticated',
  'current-password-invalid': 'password.error.currentPasswordInvalid',
  'server-rejected': 'password.error.serverRejected',
  'rate-limited': 'login.error.rateLimited',
  network: 'login.error.network',
  unknown: 'password.error.unknown',
};

/**
 * Failures of the recovery CODE step.
 *
 * A wrong code, a used code and an expired code deliberately share one
 * message: telling them apart would leak whether an address has an account.
 */
export const RECOVERY_CODE_ERROR_KEYS: Record<PasswordRecoveryCodeErrorCode, TranslationKey> = {
  'not-configured': 'login.error.misconfigured',
  'invalid-code': 'forgot.code.error.invalid',
  'expired-code': 'forgot.code.error.invalid',
  'rate-limited': 'login.error.rateLimited',
  network: 'login.error.network',
  unknown: 'forgot.code.error.invalid',
};
