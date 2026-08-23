import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildRestoreArguments,
  buildBackupArguments,
  createRestoreSnapshot,
  createBackupPaths,
  executeBackupOperation,
  executeRestoreOperation,
  finalizeBackupFile,
  parseBackupCliArguments,
  parseRestoreCliArguments,
  preparePrivateDirectory,
  reserveBackupFile,
} from "./postgres-operations.mjs";
import { createSignalAwareCommandRunner } from "./postgres-process.mjs";

const execFileAsync = promisify(execFile);

test("backup CLI는 정확한 argv 계약만 허용한다", () => {
  assert.deepEqual(parseBackupCliArguments([]), { outputDirectory: "backups" });
  assert.deepEqual(parseBackupCliArguments(["--output-dir", "/secure/backups"]), {
    outputDirectory: "/secure/backups",
  });

  for (const arguments_ of [
    ["--unknown", "value"],
    ["--output-dir"],
    ["--output-dir", "first", "--output-dir", "second"],
    ["--output-dir", "backups", "extra"],
    ["extra"],
  ]) {
    assert.throws(() => parseBackupCliArguments(arguments_), /usage: postgres-backup/);
  }
});

test("restore CLI는 정확히 하나의 --input만 허용한다", () => {
  assert.deepEqual(parseRestoreCliArguments(["--input", "/secure/review.dump"]), {
    inputPath: "/secure/review.dump",
  });

  for (const arguments_ of [
    [],
    ["--unknown", "value"],
    ["--input"],
    ["--input", "first", "--input", "second"],
    ["--input", "review.dump", "extra"],
    ["review.dump"],
  ]) {
    assert.throws(() => parseRestoreCliArguments(arguments_), /usage: postgres-restore/);
  }
});

test("backup/restore entrypoint는 잘못된 argv를 환경 검사나 child 실행 전에 거부한다", async () => {
  const backupEntrypoint = fileURLToPath(new URL("./postgres-backup.mjs", import.meta.url));
  const restoreEntrypoint = fileURLToPath(new URL("./postgres-restore.mjs", import.meta.url));
  const invalidInvocations = [
    [backupEntrypoint, ["--unknown", "value"], /usage: postgres-backup/],
    [backupEntrypoint, ["--output-dir", "one", "--output-dir", "two"], /usage: postgres-backup/],
    [backupEntrypoint, ["--output-dir", "one", "extra"], /usage: postgres-backup/],
    [restoreEntrypoint, ["--unknown", "value"], /usage: postgres-restore/],
    [restoreEntrypoint, ["--input", "one", "--input", "two"], /usage: postgres-restore/],
    [restoreEntrypoint, ["--input", "one", "extra"], /usage: postgres-restore/],
  ];

  for (const [entrypoint, arguments_, expectedError] of invalidInvocations) {
    await assert.rejects(
      execFileAsync(process.execPath, [entrypoint, ...arguments_], { env: {} }),
      (error) => {
        assert.match(error.stderr, expectedError);
        assert.doesNotMatch(error.stderr, /DATABASE_URL is required/);
        return true;
      },
    );
  }
});

test("restore는 전체 작업을 한 transaction으로 실행한다", () => {
  const arguments_ = buildRestoreArguments("review_tunnel", "/backups/review.dump");

  assert.deepEqual(arguments_, [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "--single-transaction",
    "--dbname",
    "review_tunnel",
    "/backups/review.dump",
  ]);
});

test("backup partial 경로는 충돌하기 어려운 임의 suffix를 사용한다", () => {
  const first = createBackupPaths("/backups", new Date("2026-08-24T01:02:03.456Z"));
  const second = createBackupPaths("/backups", new Date("2026-08-24T01:02:03.456Z"));

  assert.notEqual(first.finalPath, second.finalPath);
  assert.notEqual(first.temporaryPath, second.temporaryPath);
  assert.match(first.finalPath, /-[a-f0-9]{24}\.dump$/);
  assert.equal(first.temporaryPath, `${first.finalPath}.partial`);
});

test("backup partial 파일은 생성 순간부터 0600이고 기존 경로를 덮어쓰지 않는다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-backup-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const path = join(directory, "backup.dump.partial");

  const reservation = await reserveBackupFile(path);
  context.after(() => reservation.close().catch(() => undefined));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(() => reserveBackupFile(path), { code: "EEXIST" });
});

test("backup은 pg_dump가 예약한 fd로 stdout을 쓰게 한다", () => {
  assert.deepEqual(buildBackupArguments(), [
    "--format=custom",
    "--no-owner",
    "--no-acl",
  ]);
});

test("backup entrypoint는 pg_dump stdout을 private partial inode에 쓴 뒤 atomic publish한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-backup-entrypoint-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const binaryDirectory = join(directory, "bin");
  const outputDirectory = join(directory, "backups");
  await mkdir(binaryDirectory, { mode: 0o700 });
  const pgDump = join(binaryDirectory, "pg_dump");
  await writeFile(pgDump, "#!/bin/sh\nprintf 'validated-custom-archive'\n", { mode: 0o700 });

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./postgres-backup.mjs", import.meta.url)),
    "--output-dir",
    outputDirectory,
  ], {
    env: {
      DATABASE_URL: "postgres://backup:secret@db.internal:5432/review",
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
    },
  });

  const entries = await readdir(outputDirectory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /\.dump$/);
  assert.equal(await readFile(join(outputDirectory, entries[0]), "utf8"), "validated-custom-archive");
  assert.equal((await stat(join(outputDirectory, entries[0]))).mode & 0o777, 0o600);
});

test("backup output directory는 소유자 전용이 아니면 거부한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-private-dir-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  await chmod(directory, 0o777);

  await assert.rejects(() => preparePrivateDirectory(directory), /private/);
});

test("backup publish는 예약한 inode가 path에 그대로 있을 때만 성공한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-backup-inode-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const temporaryPath = join(directory, "backup.partial");
  const finalPath = join(directory, "backup.dump");
  const victimPath = join(directory, "victim");
  const reservation = await reserveBackupFile(temporaryPath);
  await reservation.writeFile("valid-dump");
  await writeFile(victimPath, "do-not-overwrite");
  await unlink(temporaryPath);
  await symlink(victimPath, temporaryPath);

  await assert.rejects(
    () => finalizeBackupFile(reservation, temporaryPath, finalPath),
    /reserved backup file changed/,
  );
  assert.equal(await readFile(victimPath, "utf8"), "do-not-overwrite");
});

test("backup publish는 atomic rename 뒤 output directory를 fsync한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-backup-fsync-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const temporaryPath = join(directory, "backup.partial");
  const finalPath = join(directory, "backup.dump");
  const reservation = await reserveBackupFile(temporaryPath);
  await reservation.writeFile("durable-archive");
  const events = [];

  await finalizeBackupFile(reservation, temporaryPath, finalPath, {
    async renameFile(source, destination) {
      events.push("rename");
      await rename(source, destination);
    },
    openDirectory(path) {
      assert.equal(path, directory);
      events.push("open-directory");
      return {
        async sync() {
          events.push("fsync-directory");
        },
        async close() {
          events.push("close-directory");
        },
      };
    },
  });

  assert.deepEqual(events, [
    "rename",
    "open-directory",
    "fsync-directory",
    "close-directory",
  ]);
  assert.equal(await readFile(finalPath, "utf8"), "durable-archive");
});

test("active child에 SIGINT와 SIGTERM을 전달하고 listener를 정리한다", async (context) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    await context.test(signal, async () => {
      const signalSource = new EventEmitter();
      const forwardedSignals = [];
      const runner = createSignalAwareCommandRunner({
        signalSource,
        spawnChild() {
          const child = new EventEmitter();
          child.kill = (forwardedSignal) => {
            forwardedSignals.push(forwardedSignal);
            queueMicrotask(() => child.emit("exit", null, forwardedSignal));
            return true;
          };
          return child;
        },
      });

      const operation = runner.run("pg_restore", ["--list", "snapshot.dump"], {});
      signalSource.emit(signal);
      await assert.rejects(operation, new RegExp(signal));
      assert.deepEqual(forwardedSignals, [signal]);
      runner.dispose();
      assert.equal(signalSource.listenerCount("SIGINT"), 0);
      assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    });
  }
});

test("restore list와 destructive restore 사이 signal은 두 번째 child 없이 snapshot을 정리한다", async () => {
  const signalSource = new EventEmitter();
  const children = [];
  let cleanupCount = 0;
  const runner = createSignalAwareCommandRunner({
    signalSource,
    spawnChild() {
      const child = new EventEmitter();
      child.kill = () => true;
      children.push(child);
      return child;
    },
  });

  try {
    const operation = executeRestoreOperation({
      inputPath: "/source/review.dump",
      databaseName: "review",
      environment: {},
      assertNotInterrupted: runner.assertNotInterrupted,
      createSnapshot: async () => ({
        path: "/private/snapshot.dump",
        async cleanup() {
          cleanupCount += 1;
        },
      }),
      runCommand(command, arguments_, environment) {
        return runner.run(command, arguments_, { env: environment });
      },
    });
    await waitFor(() => children.length === 1);
    children[0].emit("exit", 0, null);
    signalSource.emit("SIGINT");

    await assert.rejects(operation, /operation interrupted by SIGINT/);
    assert.equal(children.length, 1);
    assert.equal(cleanupCount, 1);
  } finally {
    runner.dispose();
  }
});

test("backup signal은 active pg_dump에 전달되고 unpublished partial을 정리한다", async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "review-tunnel-backup-signal-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(outputDirectory, { recursive: true }));
  });
  const temporaryPath = join(outputDirectory, "backup.partial");
  const finalPath = join(outputDirectory, "backup.dump");
  const signalSource = new EventEmitter();
  const forwardedSignals = [];
  let child;
  const runner = createSignalAwareCommandRunner({
    signalSource,
    spawnChild() {
      child = new EventEmitter();
      child.kill = (signal) => {
        forwardedSignals.push(signal);
        queueMicrotask(() => child.emit("exit", null, signal));
        return true;
      };
      return child;
    },
  });

  try {
    const operation = executeBackupOperation({
      outputDirectory,
      environment: {},
      assertNotInterrupted: runner.assertNotInterrupted,
      createPaths: () => ({ finalPath, temporaryPath }),
      runCommand(command, arguments_, environment, outputFileDescriptor) {
        return runner.run(command, arguments_, {
          env: environment,
          stdio: ["ignore", outputFileDescriptor, "inherit"],
        });
      },
    });
    await waitFor(() => child !== undefined);
    signalSource.emit("SIGTERM");

    await assert.rejects(operation, /SIGTERM/);
    assert.deepEqual(forwardedSignals, ["SIGTERM"]);
    await assert.rejects(stat(temporaryPath), { code: "ENOENT" });
    await assert.rejects(stat(finalPath), { code: "ENOENT" });
  } finally {
    runner.dispose();
  }
});

test("restore list와 restore는 원본 path가 바뀌어도 같은 private snapshot을 사용한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-restore-snapshot-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const inputPath = join(directory, "input.dump");
  const replacementPath = join(directory, "replacement.dump");
  await writeFile(inputPath, "validated-archive");
  await writeFile(replacementPath, "different-archive");

  const snapshot = await createRestoreSnapshot(inputPath);
  context.after(() => snapshot.cleanup());
  await rename(replacementPath, inputPath);

  assert.equal(await readFile(snapshot.path, "utf8"), "validated-archive");
  assert.equal((await stat(snapshot.path)).mode & 0o777, 0o600);
  assert.notEqual(snapshot.path, inputPath);
});

test("restore snapshot copy는 종료 signal을 chunk 사이에 관찰하고 partial을 정리한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-restore-cancel-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const inputPath = join(directory, "large.dump");
  await writeFile(inputPath, Buffer.alloc(3 * 1024 * 1024, 7));
  const before = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith("review-tunnel-restore-")),
  );
  let checks = 0;

  await assert.rejects(
    createRestoreSnapshot(inputPath, () => {
      checks += 1;
      if (checks >= 3) throw new Error("operation interrupted by SIGTERM");
    }),
    /interrupted by SIGTERM/,
  );
  assert.ok(checks >= 3);
  const after = (await readdir(tmpdir()))
    .filter((entry) => entry.startsWith("review-tunnel-restore-"));
  assert.deepEqual(after.filter((entry) => !before.has(entry)), []);
});

test("restore entrypoint는 list 뒤 원본이 교체되어도 검증한 동일 snapshot만 복원한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "review-tunnel-restore-entrypoint-test-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true }));
  });
  const binaryDirectory = join(directory, "bin");
  const inputPath = join(directory, "input.dump");
  const callsPath = join(directory, "pg-restore-calls");
  await mkdir(binaryDirectory, { mode: 0o700 });
  await writeFile(inputPath, "validated-archive");
  const pgRestore = join(binaryDirectory, "pg_restore");
  await writeFile(pgRestore, `#!/bin/sh
archive=""
if [ "$1" = "--list" ]; then
  archive="$2"
  printf 'replacement-archive' > ${shellQuote(inputPath)}
else
  for argument in "$@"; do archive="$argument"; done
fi
printf '%s|%s\\n' "$archive" "$(cat "$archive")" >> ${shellQuote(callsPath)}
`, { mode: 0o700 });

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./postgres-restore.mjs", import.meta.url)),
    "--input",
    inputPath,
  ], {
    env: {
      RESTORE_DATABASE_URL: "postgres://restore:secret@db.internal:5432/review",
      CONFIRM_RESTORE_TARGET: "db.internal:5432/review",
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
    },
  });

  const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
  assert.equal(calls.length, 2);
  const [listedPath, listedContent] = calls[0].split("|");
  const [restoredPath, restoredContent] = calls[1].split("|");
  assert.equal(restoredPath, listedPath);
  assert.equal(listedContent, "validated-archive");
  assert.equal(restoredContent, "validated-archive");
  assert.equal(await readFile(inputPath, "utf8"), "replacement-archive");
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for test condition");
}
