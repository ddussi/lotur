import assert from "node:assert/strict";
import { test } from "node:test";

import { bindReviewOrClose } from "./review-binding.ts";

test("review binding failure closes the active Tunnel before URL disclosure", async () => {
  const events: string[] = [];
  await assert.rejects(
    bindReviewOrClose({
      review: { projectSlug: "storefront", revisionKey: "commit-a" },
      tunnelId: "tunnel-one",
      bindReview: async () => {
        events.push("bind");
        throw new Error("binding failed");
      },
      closeTunnel: async () => {
        events.push("close");
      },
    }),
    /binding failed/,
  );
  assert.deepEqual(events, ["bind", "close"]);
});

test("review binding cleanup failure preserves both causes", async () => {
  await assert.rejects(
    bindReviewOrClose({
      review: { projectSlug: "storefront", revisionKey: "commit-a" },
      tunnelId: "tunnel-one",
      bindReview: async () => {
        throw new Error("binding failed");
      },
      closeTunnel: async () => {
        throw new Error("close failed");
      },
    }),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
  );
});

test("non-review mode leaves the existing activation flow untouched", async () => {
  let called = false;
  await bindReviewOrClose({
    tunnelId: "tunnel-one",
    bindReview: async () => {
      called = true;
    },
    closeTunnel: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
});
