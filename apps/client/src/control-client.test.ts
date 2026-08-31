import assert from "node:assert/strict";
import test from "node:test";

import {
  createCarrierAuthentication,
  postForm,
  type FetchImplementation,
} from "./control-client.ts";

test("Control 인증 POST는 redirect를 따라가지 않는다", async () => {
  let redirect: RequestRedirect | undefined;
  const fetchImplementation: FetchImplementation = async (_url, init) => {
    redirect = init?.redirect;
    return Response.json({ ok: true });
  };

  await postForm(
    "https://control.example/api/client/login",
    { username: "developer", password: "not-a-real-secret" },
    undefined,
    undefined,
    fetchImplementation,
  );

  assert.equal(redirect, "error");
});

test("초기 Carrier credential 발급 실패는 생성한 CLI 세션을 회수한다", async () => {
  const requests: Array<Readonly<{
    url: string;
    authorization?: string;
  }>> = [];
  const fetchImplementation: FetchImplementation = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({
      url: String(url),
      ...(authorization === null ? {} : { authorization }),
    });
    if (requests.length === 1) return Response.json({ sessionToken: "session-token-value-1234567890" });
    if (requests.length === 2) {
      return Response.json({ error: "AUTH_CAPACITY" }, { status: 429 });
    }
    return new Response(null, { status: 204 });
  };

  await assert.rejects(
    createCarrierAuthentication({
      controlUrl: "https://control.example",
      username: "developer",
      password: "not-a-real-secret",
      fetchImplementation,
    }),
    /AUTH_CAPACITY/,
  );

  assert.deepEqual(requests, [
    { url: "https://control.example/api/client/login" },
    {
      url: "https://control.example/api/carrier-credentials",
      authorization: "Bearer session-token-value-1234567890",
    },
    {
      url: "https://control.example/api/client/logout",
      authorization: "Bearer session-token-value-1234567890",
    },
  ]);
});

test("CLI 세션 close는 동시 호출에도 logout을 한 번만 전송한다", async () => {
  let logoutCalls = 0;
  const fetchImplementation: FetchImplementation = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/client/login") {
      return Response.json({ sessionToken: "session-token-value-1234567890" });
    }
    if (path === "/api/carrier-credentials") {
      return Response.json({
        credential: "carrier-credential-value",
        tunnelId: "issued-tunnel",
      }, { status: 201 });
    }
    logoutCalls += 1;
    return new Response(null, { status: 204 });
  };
  const authentication = await createCarrierAuthentication({
    controlUrl: "https://control.example",
    username: "developer",
    password: "not-a-real-secret",
    fetchImplementation,
  });

  await Promise.all([authentication.close(), authentication.close()]);

  assert.equal(logoutCalls, 1);
});

test("review binding은 기존 CLI 세션으로 정확한 Tunnel에 PUT한다", async () => {
  const requests: Array<Readonly<{
    path: string;
    method: string;
    authorization?: string;
    body: string;
  }>> = [];
  const fetchImplementation: FetchImplementation = async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({
      path,
      method: init?.method ?? "GET",
      ...(new Headers(init?.headers).get("authorization") === null
        ? {}
        : { authorization: new Headers(init?.headers).get("authorization")! }),
      body: String(init?.body ?? ""),
    });
    if (path === "/api/client/login") {
      return Response.json({ sessionToken: "session-token-value-1234567890" });
    }
    if (path === "/api/carrier-credentials") {
      return Response.json({
        credential: "carrier-credential-value",
        tunnelId: "issued-tunnel",
      }, { status: 201 });
    }
    if (path.startsWith("/api/client/review-bindings/")) {
      return Response.json({ project: { slug: "storefront" }, revision: { key: "commit-a" } });
    }
    return new Response(null, { status: 204 });
  };
  const authentication = await createCarrierAuthentication({
    controlUrl: "https://control.example",
    username: "developer",
    password: "not-a-real-secret",
    fetchImplementation,
  });

  await authentication.bindReview({
    tunnelId: "issued-tunnel",
    projectSlug: "storefront",
    revisionKey: "commit-a",
  });
  await authentication.close();

  assert.deepEqual(requests[2], {
    path: "/api/client/review-bindings/issued-tunnel",
    method: "PUT",
    authorization: "Bearer session-token-value-1234567890",
    body: "projectSlug=storefront&revisionKey=commit-a",
  });
});
