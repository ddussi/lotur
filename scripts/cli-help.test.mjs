import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const workspaceRoot = new URL("../", import.meta.url);
const { DATABASE_URL: _databaseUrl, ...environmentWithoutDatabase } = process.env;

test("사용자용 CLI 도움말은 외부 설정이나 서버 연결 없이 표시된다", async () => {
  const commands = [
    ["apps/lan/src/main.ts", "npm run share:lan"],
    ["apps/client/src/main.ts", "npm run share"],
    ["apps/admin-cli/src/main.ts", "npm run admin"],
  ];

  for (const [entrypoint, expected] of commands) {
    const { stdout, stderr } = await execute(
      process.execPath,
      ["--experimental-strip-types", entrypoint, "--help"],
      {
        cwd: workspaceRoot,
        env: environmentWithoutDatabase,
      },
    );
    assert.match(stdout, new RegExp(expected));
    assert.equal(stderr, "");
  }
});
