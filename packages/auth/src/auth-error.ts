export type AuthErrorCode =
  | "BOOTSTRAP_CLOSED"
  | "ACCOUNT_EXISTS"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_ACCOUNT_INPUT"
  | "INVALID_CREDENTIALS"
  | "LOGIN_THROTTLED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "WEAK_PASSWORD"
  | "FORBIDDEN"
  | "LAST_ADMINISTRATOR";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(
    code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
