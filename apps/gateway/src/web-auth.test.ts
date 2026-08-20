import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, parseCookie } from "./web-auth.ts";

test("cookie parser rejects duplicate authentication cookies", () => {
  assert.equal(parseCookie("other=1; rt_session_dev=abc", "rt_session_dev"), "abc");
  assert.equal(
    parseCookie("rt_session_dev=abc; rt_session_dev=attacker", "rt_session_dev"),
    undefined,
  );
});

test("admin UI escapes account-controlled text", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});
