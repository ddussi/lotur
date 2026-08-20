import { once } from "node:events";
import { stdin, stdout } from "node:process";

export async function readSecrets(
  prompts: readonly string[],
  passwordStdin: boolean,
): Promise<readonly string[]> {
  if (passwordStdin) {
    let input = "";
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    await once(stdin, "end");
    const lines = input.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== prompts.length) {
      throw new Error(`--password-stdin expects exactly ${prompts.length} line(s)`);
    }
    return lines;
  }
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("A TTY is required. For automation, explicitly use --password-stdin.");
  }
  const values: string[] = [];
  for (const prompt of prompts) values.push(await readHiddenLine(prompt));
  return values;
}

async function readHiddenLine(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  const valueBytes: number[] = [];
  try {
    while (true) {
      const [chunk] = await once(stdin, "data") as [Buffer];
      for (const byte of chunk) {
        if (byte === 3) throw new Error("Cancelled");
        if (byte === 13 || byte === 10) {
          stdout.write("\n");
          return Buffer.from(valueBytes).toString("utf8");
        }
        if (byte === 127 || byte === 8) removeLastUtf8CodePoint(valueBytes);
        else if (byte >= 32) valueBytes.push(byte);
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function removeLastUtf8CodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  const removed = bytes.pop() ?? 0;
  if ((removed & 0xc0) !== 0x80) return;
  while (bytes.length > 0 && ((bytes.at(-1) ?? 0) & 0xc0) === 0x80) bytes.pop();
  bytes.pop();
}
