import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("배포 실패·복구·이전 버전 덮어쓰기 방지를 실제 제어 흐름으로 확인한다", async () => {
  const { stderr } = await promisify(execFile)(
    "python3",
    [fileURLToPath(new URL("test_deployment.py", import.meta.url))],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.match(stderr, /\bOK\b/);
});

test("배포는 main 검사 성공 뒤에만 실행하고 배포 중 취소와 SSH 호스트 검증 해제를 피한다", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const publication = source.slice(source.indexOf("\n  publish:"), source.indexOf("\n  deploy:"));
  const rollout = source.slice(source.indexOf("\n  deploy:"));
  assert.match(publication, /needs: verification/);
  assert.match(publication, /github\.ref == 'refs\/heads\/main'/);
  assert.match(publication, /github\.event_name == 'push'/);
  assert.match(publication, /vars\.AUTO_DEPLOY_ENABLED == 'true'/);
  assert.match(publication, /!inputs\.candidate_images/);
  assert.match(publication, /packages: write/);
  assert.match(rollout, /needs: publish/);
  assert.match(rollout, /name: production/);
  assert.match(rollout, /cancel-in-progress: false/);
  assert.match(publication, /git\/ref\/heads\/main/);
  assert.match(rollout, /if: needs\.publish\.outputs\.current == 'true'/);
  assert.match(rollout, /REGISTRY_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(source, /pull_request_target|workflow_run|StrictHostKeyChecking=no|ssh-keyscan/);
  assert.doesNotMatch(rollout, /DATABASE_URL|AUTH_SESSION_HMAC_KEY|ADMIN_PASSWORD/);
  for (const name of ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PORT"]) {
    assert.ok(rollout.includes(`secrets.${name}`), `${name} must be masked as a production environment secret`);
    assert.ok(!rollout.includes(`vars.${name}`), `${name} must not be printed as a plain Actions variable`);
  }
});

test("candidate image publication requires the full gate and an explicit manual run without production secrets", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const candidate = source.slice(source.indexOf("\n  candidate-images:"), source.indexOf("\n  publish:"));
  assert.match(candidate, /needs: \[verification, candidate-package-inventory\]/);
  assert.match(candidate, /github\.event_name == 'workflow_dispatch' && inputs\.candidate_images/);
  assert.match(candidate, /packages: write/);
  assert.match(candidate, /persist-credentials: false/);
  assert.doesNotMatch(candidate, /environment:|DEPLOY_|deploy-over-ssh|contents: write/);
});
