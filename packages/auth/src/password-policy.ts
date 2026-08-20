import { AuthError } from "./auth-error.ts";

const COMMON_PASSWORDS = new Set([
  "passwordpassword",
  "password123456",
  "qwertyuiop12345",
  "123456789012345",
]);

export function validatePassword(password: string): void {
  if (password.length < 15 || password.length > 128) {
    throw new AuthError(
      "WEAK_PASSWORD",
      "비밀번호는 15자 이상 128자 이하여야 합니다.",
    );
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AuthError("WEAK_PASSWORD", "널리 사용되는 비밀번호는 사용할 수 없습니다.");
  }
}

export function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) {
    throw new AuthError(
      "INVALID_ACCOUNT_INPUT",
      "아이디는 영문 소문자 또는 숫자로 시작하는 3~64자의 영문·숫자·점·밑줄·하이픈이어야 합니다.",
    );
  }
  return normalized;
}

export function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length < 1 || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AuthError("INVALID_ACCOUNT_INPUT", "표시 이름은 1~80자여야 합니다.");
  }
  return normalized;
}
