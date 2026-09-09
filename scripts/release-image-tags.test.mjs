import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_TARGETS } from "./release-artifacts.mjs";
import { releaseImageTags } from "./release-image-tags.mjs";

const context = { repository: "example/project", revision: "a".repeat(40), version: "0.1.0-alpha.1" };
const digest = `sha256:${"b".repeat(64)}`;
const config = `sha256:${"c".repeat(64)}`;
const candidateTag = `candidate-${context.revision}-123-1`;
const record = { format: "review-tunnel-images-v1", source: { revision: context.revision }, version: context.version,
  repository: context.repository, platform: "linux/amd64", candidateTag,
  images: RUNTIME_TARGETS.map(target => ({ target, tag: `ghcr.io/${context.repository}-${target}:${candidateTag}`,
    reference: `ghcr.io/${context.repository}-${target}@${digest}`, configDigest: config, visibility: "private" })) };

function registry({ collision, denied, wrongSource, changedPublish = false, existing = [] } = {}) {
  const calls = [];
  const tags = new Map(existing.map(target => [`ghcr.io/${context.repository}-${target}:v${context.version}`, digest]));
  const docker = async args => {
    calls.push(args);
    const reference = args[3];
    const target = RUNTIME_TARGETS.find(value => reference?.includes(`project-${value}:`));
    if (args[0] === "buildx" && args[2] === "inspect") {
      if (denied && target === denied) return { code: 1, stdout: "", stderr: "403 forbidden: not found" };
      if (collision && target === collision) return { code: 0, stdout: JSON.stringify({ digest: `sha256:${"d".repeat(64)}` }), stderr: "" };
      const found = reference.includes("@") ? digest : tags.get(reference);
      return found ? { code: 0, stdout: JSON.stringify({ digest: found }), stderr: "" } : { code: 1, stdout: "", stderr: "manifest unknown" };
    }
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify([{ Id: config, Os: "linux", Architecture: "amd64", Config: { Labels: {
      "org.opencontainers.image.revision": wrongSource ? "e".repeat(40) : context.revision,
      "org.opencontainers.image.version": context.version,
      "org.opencontainers.image.source": `https://github.com/${context.repository}`,
    } } }]), stderr: "" };
    if (args[0] === "buildx" && args[2] === "create" && !args.includes("--dry-run")) {
      tags.set(args[args.indexOf("--tag") + 1], changedPublish ? `sha256:${"f".repeat(64)}` : digest);
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  return { docker, calls, tags };
}

test("dry run checks all six candidate sources without creating version tags", async () => {
  const runtime = registry();
  const result = await releaseImageTags(record, context, runtime);
  assert.equal(result.status, "dry-run");
  assert.equal(result.images.length, 6);
  assert.equal(runtime.tags.size, 0);
  assert.equal(runtime.calls.filter(args => args[2] === "create" && args.includes("--dry-run")).length, 6);
  assert.ok(runtime.calls.filter(args => args[2] === "create").every(args => args.includes("--prefer-index=false") && args.at(-1).includes("@sha256:")));
});

test("even a last-target collision or denied lookup stops before the first version write", async () => {
  for (const options of [{ collision: "db-restore" }, { denied: "db-restore" }, { wrongSource: true }]) {
    const runtime = registry(options);
    await assert.rejects(releaseImageTags(record, context, { ...runtime, publish: true }), /different contents|Cannot inspect|identity mismatch/);
    assert.equal(runtime.calls.some(args => args[2] === "create"), false);
  }
});

test("publication resumes matching partial tags and verifies the resulting registry digests", async () => {
  const runtime = registry({ existing: ["gateway", "client"] });
  const result = await releaseImageTags(record, context, { ...runtime, publish: true });
  assert.equal(result.status, "published");
  assert.equal(runtime.tags.size, 6);
  assert.equal(runtime.calls.filter(args => args[2] === "create").length, 4);
  assert.ok([...runtime.tags.values()].every(value => value === digest));
  assert.equal(runtime.calls.some(args => ["build", "push"].includes(args[0])), false);
});

test("a registry manifest rewrite cannot be reported as a successful promotion", async () => {
  const runtime = registry({ changedPublish: true });
  await assert.rejects(releaseImageTags(record, context, { ...runtime, publish: true }), /differs from the candidate/);
  assert.equal(runtime.calls.filter(args => args[2] === "create").length, 1);
});

test("mixed source commits and altered repository destinations are refused without registry access", async () => {
  for (const selected of [{ ...context, revision: "e".repeat(40) }, { ...context, repository: "another/project" }]) {
    const runtime = registry();
    await assert.rejects(releaseImageTags(record, selected, runtime), /source, version, platform or target inventory/);
    assert.equal(runtime.calls.length, 0);
  }
});
