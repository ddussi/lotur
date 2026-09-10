export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CarrierAuthentication = Readonly<{
  carrierCredential: string;
  tunnelId: string;
  issueResumeCredential(
    purpose: "resume",
    tunnelId: string,
    signal: AbortSignal,
  ): Promise<string>;
  bindReview(input: Readonly<{
    tunnelId: string;
    projectSlug: string;
    revisionKey: string;
    workingTree?: "clean" | "modified" | "unknown";
  }>, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}>;

export async function createCarrierAuthentication(input: Readonly<{
  controlUrl: string;
  username: string;
  password: string;
  fetchImplementation?: FetchImplementation;
}>): Promise<CarrierAuthentication> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const login = await postForm(
    `${input.controlUrl}/api/client/login`,
    { username: input.username, password: input.password },
    undefined,
    undefined,
    fetchImplementation,
  );
  if (typeof login.sessionToken !== "string") {
    throw new Error("Gateway returned an invalid login response");
  }
  const sessionToken = login.sessionToken;
  let closePromise: Promise<void> | undefined;
  const close = (signal?: AbortSignal): Promise<void> => {
    closePromise ??= postFormWithoutResponse(
      `${input.controlUrl}/api/client/logout`,
      {},
      sessionToken,
      signal,
      fetchImplementation,
    );
    return closePromise;
  };

  try {
    const issued = await postForm(
      `${input.controlUrl}/api/carrier-credentials`,
      { purpose: "create" },
      sessionToken,
      undefined,
      fetchImplementation,
    );
    if (typeof issued.credential !== "string" || typeof issued.tunnelId !== "string") {
      throw new Error("Gateway returned an invalid Carrier credential");
    }
    return {
      carrierCredential: issued.credential,
      tunnelId: issued.tunnelId,
      async issueResumeCredential(purpose, tunnelId, signal) {
        const resumed = await postForm(
          `${input.controlUrl}/api/carrier-credentials`,
          { purpose, tunnelId },
          sessionToken,
          signal,
          fetchImplementation,
        );
        if (typeof resumed.credential !== "string") {
          throw new Error("Gateway returned an invalid Carrier credential");
        }
        return resumed.credential;
      },
      async bindReview(binding, signal) {
        await postForm(
          `${input.controlUrl}/api/client/review-bindings/${encodeURIComponent(binding.tunnelId)}`,
          {
            projectSlug: binding.projectSlug,
            revisionKey: binding.revisionKey,
            ...(binding.workingTree === undefined ? {} : { workingTree: binding.workingTree }),
          },
          sessionToken,
          signal,
          fetchImplementation,
          "PUT",
        );
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `Gateway authentication failed and CLI session cleanup also failed: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

export async function postForm(
  url: string,
  values: Readonly<Record<string, string>>,
  bearer?: string,
  signal?: AbortSignal,
  fetchImplementation: FetchImplementation = fetch,
  method: "POST" | "PUT" = "POST",
): Promise<Record<string, unknown>> {
  const response = await sendForm(
    url,
    values,
    bearer,
    signal,
    fetchImplementation,
    method,
  );
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : `HTTP_${response.status}`;
    throw new Error(`Gateway authentication failed: ${code}`);
  }
  if (typeof body !== "object" || body === null) {
    throw new Error("Gateway returned invalid JSON");
  }
  return body as Record<string, unknown>;
}

async function postFormWithoutResponse(
  url: string,
  values: Readonly<Record<string, string>>,
  bearer: string,
  signal: AbortSignal | undefined,
  fetchImplementation: FetchImplementation,
): Promise<void> {
  const response = await sendForm(
    url,
    values,
    bearer,
    signal,
    fetchImplementation,
    "POST",
  );
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Gateway authentication cleanup failed: HTTP_${response.status}`);
  }
}

function sendForm(
  url: string,
  values: Readonly<Record<string, string>>,
  bearer: string | undefined,
  signal: AbortSignal | undefined,
  fetchImplementation: FetchImplementation,
  method: "POST" | "PUT",
): Promise<Response> {
  const requestSignal = signal === undefined
    ? AbortSignal.timeout(10_000)
    : AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  return fetchImplementation(url, {
    method,
    redirect: "error",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-review-tunnel-client": "1",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: new URLSearchParams(values),
    signal: requestSignal,
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "unknown error";
}
