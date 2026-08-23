import { randomBytes } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const COPY_BUFFER_BYTES = 1024 * 1024;

export function parseBackupCliArguments(arguments_) {
  if (arguments_.length === 0) return { outputDirectory: "backups" };
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output-dir" ||
    arguments_[1] === "" ||
    arguments_[1].startsWith("-")
  ) {
    throw new Error("usage: postgres-backup.mjs [--output-dir PATH]");
  }
  return { outputDirectory: arguments_[1] };
}

export function parseRestoreCliArguments(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--input" ||
    arguments_[1] === "" ||
    arguments_[1].startsWith("-")
  ) {
    throw new Error("usage: postgres-restore.mjs --input PATH");
  }
  return { inputPath: arguments_[1] };
}

export function buildRestoreArguments(databaseName, inputPath) {
  return [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "--single-transaction",
    "--dbname",
    databaseName,
    inputPath,
  ];
}

export function buildBackupArguments() {
  return [
    "--format=custom",
    "--no-owner",
    "--no-acl",
  ];
}

export function createBackupPaths(outputDirectory, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(12).toString("hex");
  const finalPath = join(
    outputDirectory,
    `review-tunnel-${timestamp}-${suffix}.dump`,
  );
  return { finalPath, temporaryPath: `${finalPath}.partial` };
}

export async function reserveBackupFile(path) {
  return open(path, "wx", 0o600);
}

export async function preparePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("backup output directory must be a private directory, not a symlink");
  }
  if ((information.mode & 0o077) !== 0) {
    throw new Error("backup output directory must be private to its owner");
  }
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId !== undefined && information.uid !== effectiveUserId) {
    throw new Error("backup output directory must be owned by the current user");
  }
}

export async function finalizeBackupFile(
  reservation,
  temporaryPath,
  finalPath,
  dependencies = {},
) {
  const renameFile = dependencies.renameFile ?? rename;
  const openDirectory = dependencies.openDirectory ?? open;
  const beforePublish = dependencies.beforePublish ?? (() => undefined);
  let reservationClosed = false;
  try {
    await reservation.sync();
    const [reservedInformation, pathInformation] = await Promise.all([
      reservation.stat(),
      lstat(temporaryPath),
    ]);
    if (
      !reservedInformation.isFile() ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      reservedInformation.dev !== pathInformation.dev ||
      reservedInformation.ino !== pathInformation.ino ||
      reservedInformation.nlink !== 1 ||
      pathInformation.nlink !== 1
    ) {
      throw new Error("reserved backup file changed before publish");
    }
    if (reservedInformation.size === 0) {
      throw new Error("pg_dump produced an empty backup");
    }
    await reservation.close();
    reservationClosed = true;
    await beforePublish();
    await renameFile(temporaryPath, finalPath);
    const directory = await openDirectory(dirname(finalPath), fileConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!reservationClosed) await reservation.close().catch(() => undefined);
  }
}

export async function executeBackupOperation(input) {
  const prepareDirectory = input.prepareDirectory ?? preparePrivateDirectory;
  const createPaths = input.createPaths ?? createBackupPaths;
  const reserveFile = input.reserveFile ?? reserveBackupFile;
  const finalizeFile = input.finalizeFile ?? finalizeBackupFile;
  const assertNotInterrupted = input.assertNotInterrupted ?? (() => undefined);
  await prepareDirectory(input.outputDirectory);
  const { finalPath, temporaryPath } = createPaths(input.outputDirectory);
  let reservation;
  try {
    assertNotInterrupted();
    reservation = await reserveFile(temporaryPath);
    assertNotInterrupted();
    await input.runCommand(
      "pg_dump",
      buildBackupArguments(),
      input.environment,
      reservation.fd,
    );
    assertNotInterrupted();
    await finalizeFile(reservation, temporaryPath, finalPath, {
      beforePublish: assertNotInterrupted,
    });
    reservation = undefined;
    return finalPath;
  } catch (error) {
    await reservation?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function executeRestoreOperation(input) {
  const createSnapshot = input.createSnapshot ?? createRestoreSnapshot;
  const assertNotInterrupted = input.assertNotInterrupted ?? (() => undefined);
  const snapshot = await createSnapshot(input.inputPath, assertNotInterrupted);
  try {
    assertNotInterrupted();
    await input.runCommand(
      "pg_restore",
      ["--list", snapshot.path],
      input.environment,
    );
    assertNotInterrupted();
    await input.runCommand(
      "pg_restore",
      buildRestoreArguments(input.databaseName, snapshot.path),
      input.environment,
    );
    assertNotInterrupted();
  } finally {
    await snapshot.cleanup();
  }
}

export async function createRestoreSnapshot(
  inputPath,
  assertNotInterrupted = () => undefined,
) {
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  assertNotInterrupted();
  const source = await open(inputPath, fileConstants.O_RDONLY | noFollow);
  let snapshotDirectory;
  let destination;
  try {
    const sourceBefore = await source.stat();
    if (!sourceBefore.isFile() || sourceBefore.size === 0) {
      throw new Error("restore input must be a non-empty regular file");
    }
    snapshotDirectory = await mkdtemp(join(tmpdir(), "review-tunnel-restore-"));
    await preparePrivateDirectory(snapshotDirectory);
    assertNotInterrupted();
    const snapshotPath = join(snapshotDirectory, "restore.dump");
    destination = await open(snapshotPath, "wx", 0o600);
    await copyFileSnapshot(
      source,
      destination,
      sourceBefore.size,
      assertNotInterrupted,
    );
    assertNotInterrupted();
    await destination.sync();
    const [sourceAfter, snapshotInformation] = await Promise.all([
      source.stat(),
      destination.stat(),
    ]);
    if (
      sourceAfter.size !== sourceBefore.size ||
      sourceAfter.mtimeMs !== sourceBefore.mtimeMs ||
      sourceAfter.ctimeMs !== sourceBefore.ctimeMs ||
      snapshotInformation.size !== sourceBefore.size
    ) {
      throw new Error("restore input changed while creating its immutable snapshot");
    }
    await destination.close();
    destination = undefined;
    await source.close();
    let cleaned = false;
    return {
      path: snapshotPath,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(snapshotDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    if (snapshotDirectory !== undefined) {
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function copyFileSnapshot(
  source,
  destination,
  expectedSize,
  assertNotInterrupted,
) {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, expectedSize));
  let copied = 0;
  while (copied < expectedSize) {
    assertNotInterrupted();
    const length = Math.min(buffer.byteLength, expectedSize - copied);
    const { bytesRead } = await source.read(buffer, 0, length, null);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      assertNotInterrupted();
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        null,
      );
      written += result.bytesWritten;
    }
    copied += bytesRead;
  }
  if (copied !== expectedSize) {
    throw new Error("restore input changed while creating its immutable snapshot");
  }
}
