import assert from "node:assert/strict";
import test from "node:test";
import { candidateContext, publishCandidateImages, verifyImageRecord, IMAGE_PLATFORM } from "./candidate-images.mjs";
import { RUNTIME_TARGETS } from "./release-artifacts.mjs";

const environment = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "example/project",
  GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1" };
const event = { inputs: { candidate_images: "true", candidate_visibility: "private" } };
const context = candidateContext(environment, event, "0.1.0-alpha.1");
const success = stdout => ({ code: 0, stdout, stderr: "" });
const failure = stderr => ({ code: 1, stdout: "", stderr });

function registry({ visibility = "private", wrongRevision = false, existingTag = false, denied = false, smokeSuccess = false, wrongSource = false } = {}) {
  const operations = [];
  const packageInfo = async target => {
    operations.push(["package", target]);
    if (denied) throw new Error("package access denied");
    return { visibility, name: `project-${target}`, owner: { login: "example" }, latestDigest: `sha256:${"d".repeat(64)}` };
  };
  const docker = async args => {
    operations.push(args);
    if (args[0] === "manifest") return existingTag ? success("{}") : failure("manifest unknown");
    if (args[0] === "image") {
      const name = args[2].split(/[:@]/)[0];
      return success(JSON.stringify([{ Id: `sha256:${"b".repeat(64)}`, RepoDigests: [`${name}@sha256:${"c".repeat(64)}`],
        Os: "linux", Architecture: "amd64", Config: { Labels: {
          "org.opencontainers.image.revision": wrongRevision && args[2].includes("@") ? "d".repeat(40) : context.revision,
          "org.opencontainers.image.source": wrongSource ? "https://github.com/example/different" : `https://github.com/${context.repository}`,
          "org.opencontainers.image.version": context.version, "org.opencontainers.image.licenses": "MIT",
        } } }]));
    }
    if (args[0] === "run") {
      if (args.at(-1) === "--version") return success(`${context.version}\n`);
      if (smokeSuccess) return success("Usage:");
      const target = RUNTIME_TARGETS.find(target => args.at(-1).startsWith(`ghcr.io/${context.repository}-${target}:`) || args.at(-1).startsWith(`ghcr.io/${context.repository}-${target}@`));
      return failure({ gateway: "METRICS_BEARER_TOKEN must contain at least 32", "admin-cli": "DATABASE_URL is required",
        client: "Usage:", "canary-check": "CANARY_CONTENT_URL is required", "db-backup": "DATABASE_URL is required", "db-restore": "usage: postgres-restore" }[target]);
    }
    return success("");
  };
  return { packageInfo, docker, operations };
}

test("candidate publication requires explicit manual input and bounded GitHub identities", () => {
  for (const source of [{ ...environment, GITHUB_EVENT_NAME: "push" }, { ...environment, GITHUB_SHA: "main" },
    { ...environment, GITHUB_REPOSITORY: "example/project;echo" }, { ...environment, GITHUB_RUN_ATTEMPT: "0" }]) {
    assert.throws(() => candidateContext(source, event, context.version));
  }
  assert.throws(() => candidateContext(environment, { inputs: { candidate_images: "false" } }, context.version));
  assert.equal(candidateContext(environment, event, context.version).tag, context.tag);
});

test("all package destinations are checked before publication and existing tags are preserved", async () => {
  for (const options of [{ visibility: "public" }, { denied: true }, { existingTag: true }, { wrongSource: true }]) {
    const runtime = registry(options);
    await assert.rejects(publishCandidateImages(context, runtime), /visibility|access denied|already exists|different or unidentified source/);
    assert.equal(runtime.operations.filter(args => ["build", "push"].includes(args[0])).length, 0);
  }
});

test("candidate images are checked before push and again by digest after pulling all six targets", async () => {
  const runtime = registry();
  const record = await publishCandidateImages(context, runtime);
  assert.equal(record.platform, IMAGE_PLATFORM);
  assert.deepEqual(record.images.map(image => image.target), RUNTIME_TARGETS);
  assert.equal(runtime.operations.filter(args => args[0] === "push").length, 6);
  assert.equal(runtime.operations.filter(args => args[0] === "pull" && args.at(-1).includes("@sha256:")).length, 12);
  assert.equal(runtime.operations.filter(args => args[0] === "run" && args.includes("--network") && args.some(arg => arg.includes("@sha256:"))).length, 7);
  assert.equal(runtime.operations.slice(0, 6).every(args => args[0] === "package"), true);
  const changed = structuredClone(record); changed.images[0].reference = changed.images[0].tag;
  assert.throws(() => verifyImageRecord(changed, context), /immutable image identity/);
  assert.throws(() => verifyImageRecord(record, { ...context, revision: "f".repeat(40) }), /source/);
});

test("a wrong pulled source or unexpectedly successful invalid configuration cannot complete a candidate", async () => {
  await assert.rejects(publishCandidateImages(context, registry({ wrongRevision: true })), /differs from the checked source/);
  const runtime = registry({ smokeSuccess: true });
  await assert.rejects(publishCandidateImages(context, runtime), /smoke result/);
  assert.equal(runtime.operations.some(args => args[0] === "push"), false);
});

test("a newly created private target is checked after publication without assuming a prior image", async () => {
  const runtime = registry();
  const inspect = runtime.packageInfo;
  let calls = 0;
  runtime.packageInfo = async target => target === "client" && calls++ === 0 ? undefined : inspect(target);
  const record = await publishCandidateImages(context, runtime);
  assert.equal(record.images.find(image => image.target === "client").visibility, "private");
  assert.equal(runtime.operations.filter(args => args[0] === "pull").length, 11);
});
