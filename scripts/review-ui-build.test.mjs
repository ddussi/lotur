import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("the served review bootstrap matches the typed browser modules", async () => {
  const result = await promisify(execFile)(process.execPath, ["scripts/build-review-ui.mjs", "--check"], {
    cwd: new URL("../", import.meta.url),
  });
  assert.equal(result.stderr, "");
});
