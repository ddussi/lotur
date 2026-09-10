import { parseLoopbackOrigin, resolveAndProbeLocalOrigin } from "./local-origin.ts";
import { createCarrierAuthentication, type FetchImplementation } from "./control-client.ts";
import type { ClientOptions } from "./cli-options.ts";

export type DiagnosticCheck = Readonly<{
  name: string;
  status: "pass" | "fail" | "skip";
  message: string;
}>;

export function explainClientFailure(error: unknown, stage: "local" | "server" | "account" | "tunnel"): string {
  const message = error instanceof Error ? error.message : "";
  for (const [code, explanation] of [
    ["INVALID_CREDENTIALS", "아이디와 비밀번호를 확인하세요. 계정이 정지된 경우 운영자에게 문의하세요."],
    ["PASSWORD_CHANGE_REQUIRED", "로그인 페이지에서 초기 비밀번호를 변경한 뒤 다시 실행하세요."],
    ["FORBIDDEN", "개발자(DEVELOPER) 권한이 필요합니다. 운영자에게 계정 권한을 확인하세요."],
    ["LOGIN_THROTTLED", "로그인 시도가 너무 많습니다. 잠시 기다린 뒤 다시 실행하세요."],
    ["AUTH_CAPACITY", "서버의 로그인 처리 한도에 도달했습니다. 잠시 후 다시 시도하세요."],
    ["TUNNEL_LIMIT_EXCEEDED", "공유 연결 또는 발급 요청 한도에 도달했습니다. 사용하지 않는 공유를 종료하고 잠시 후 다시 시도하세요."],
    ["SERVICE_DISABLED", "서버에서 공유가 중지되었습니다. 운영자에게 문의하세요."],
  ] as const) if (message.includes(code)) return explanation;
  if (stage === "local" || /local origin|LOCAL_ORIGIN|LOCAL_CONNECT/.test(message)) {
    return "로컬 웹앱을 먼저 실행하고 주소와 포트를 확인하세요. http://127.0.0.1:3000 같은 로컬 HTTP 주소를 사용하세요.";
  }
  if (stage === "account") return "로그인 또는 연결 자격 발급에 실패했습니다. 서버 주소와 개발자 계정을 확인하세요.";
  if (stage === "server") return "공유 서버에 연결할 수 없습니다. --gateway 주소, 인터넷 연결, 서버의 HTTPS 설정을 확인하세요.";
  return "터널 연결에 실패했습니다. doctor로 로컬 앱·서버·계정을 점검하고, 운영자에게 WebSocket 연결과 공유 허용 상태를 확인하세요.";
}

export async function diagnoseClient(input: Readonly<{
  options: ClientOptions;
  readPassword(): Promise<string>;
  report(check: DiagnosticCheck): void;
  fetchImplementation?: FetchImplementation;
  probeLocal?: typeof resolveAndProbeLocalOrigin;
}>): Promise<boolean> {
  const checks: DiagnosticCheck[] = [];
  const report = (check: DiagnosticCheck) => { checks.push(check); input.report(check); };
  try {
    await (input.probeLocal ?? resolveAndProbeLocalOrigin)(parseLoopbackOrigin(input.options.localOrigin));
    report({ name: "로컬 웹앱", status: "pass", message: "로컬 포트에 연결됩니다. 페이지 동작은 브라우저에서 확인하세요." });
  } catch (error) {
    report({ name: "로컬 웹앱", status: "fail", message: explainClientFailure(error, "local") });
  }
  const fetchImplementation = input.fetchImplementation ?? fetch;
  let serverReady = false;
  try {
    const response = await fetchImplementation(`${input.options.controlUrl}/health/ready`, {
      redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    serverReady = response.status === 200;
    report({ name: "공유 서버", status: serverReady ? "pass" : "fail", message: serverReady
      ? "서버와 저장소의 상태 검사를 통과했습니다."
      : response.status === 503 ? "서버는 응답하지만 준비되지 않았습니다. 운영자에게 DB 연결 상태를 확인하세요."
      : "서버 상태 확인 경로에 접근하지 못했습니다. --gateway 주소와 프록시 설정을 확인하세요." });
  } catch (error) {
    report({ name: "공유 서버", status: "fail", message: explainClientFailure(error, "server") });
  }
  if (input.options.username === undefined || !serverReady) {
    report({ name: "개발자 계정", status: "skip", message: serverReady
      ? "--username을 지정하면 로그인과 개발자 권한도 확인합니다."
      : "공유 서버 문제를 해결한 뒤 계정을 확인할 수 있습니다." });
  } else {
    let authentication: Awaited<ReturnType<typeof createCarrierAuthentication>> | undefined;
    try {
      authentication = await createCarrierAuthentication({
        controlUrl: input.options.controlUrl, username: input.options.username,
        password: await input.readPassword(), fetchImplementation,
      });
      report({ name: "개발자 계정", status: "pass", message: "로그인과 새 연결 자격 발급에 성공했습니다." });
    } catch (error) {
      report({ name: "개발자 계정", status: "fail", message: explainClientFailure(error, "account") });
      if (error instanceof AggregateError) report({ name: "진단 세션 정리", status: "fail", message: "임시 로그인 세션 정리도 실패했습니다. 계정 페이지에서 세션을 종료하세요." });
    } finally {
      if (authentication !== undefined) {
        try { await authentication.close(); }
        catch { report({ name: "진단 세션 정리", status: "fail", message: "임시 로그인 세션을 종료하지 못했습니다. 계정 페이지에서 세션을 종료하세요." }); }
      }
    }
  }
  return checks.every(check => check.status !== "fail");
}
