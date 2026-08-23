export type ResumeOwnerAuthorization = Readonly<{
  accountId: string;
  accountAuthVersion: number;
}>;

export function resumeOwnerAuthorizationMatches(
  existing: ResumeOwnerAuthorization | undefined,
  candidate: ResumeOwnerAuthorization | undefined,
): boolean {
  return existing?.accountId === candidate?.accountId &&
    existing?.accountAuthVersion === candidate?.accountAuthVersion;
}
