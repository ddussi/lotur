// Execute inside a runtime image with Node.js on stdin. Output contains package
// identities and notice hashes only; no environment variables or file contents.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

function notice(path) {
  const bytes = readFileSync(path);
  if (!bytes.length) throw new Error(`Empty notice: ${path}`);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const nodeNotice = notice("/usr/local/LICENSE");
const projectNotice = notice("/app/LICENSE");
const commonNotices = readdirSync("/usr/share/common-licenses").sort()
  .map(name => notice(join("/usr/share/common-licenses", name)));
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal dpkg-query field syntax, passed without a shell
const osPackages = execFileSync("dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\n"], { encoding: "utf8" })
  .trimEnd().split("\n").map(line => line.split("\t")).filter(fields => fields[2].startsWith("ii"))
  .map(([name, version]) => ({ name, version, notice: notice(`/usr/share/doc/${name}/copyright`) }));
const npmPackages = [];
// These upstream tarballs put the complete MIT text in README.md. Pin the
// reviewed bytes so a dependency update cannot silently change that decision.
const readmeNotices = {
  "pg-types@2.2.0": "ecda9bca71d3f0cee4e600d1dd2bef336213f39ef2e8fca6a1a1c1c8723f643a",
  "pgpass@1.0.5": "62549909404b5a0dcb2b4b74c9a930baf8095dbcfa1543c4ffc79378acd22b57",
};
if (existsSync("/app/package-lock.json")) {
  const lock = JSON.parse(readFileSync("/app/package-lock.json", "utf8"));
  for (const [path, item] of Object.entries(lock.packages).filter(([path]) => path.startsWith("node_modules/"))) {
    const directory = join("/app", path);
    const names = readdirSync(directory, { recursive: true }).filter(name => /^(licen[cs]e|copying)([._-]|$)/i.test(basename(name)) && statSync(join(directory, name)).isFile()).sort();
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (metadata.version !== item.version) throw new Error(`Installed version differs from the runtime lockfile: ${path}`);
    const identity = `${metadata.name}@${metadata.version}`;
    const notices = names.map(name => notice(join(directory, name)));
    let noticeSource = "upstream-file";
    if (!names.some(name => !name.includes("/"))) {
      if (readmeNotices[identity]) {
        const readme = notice(join(directory, "README.md"));
        if (readme.sha256 !== readmeNotices[identity]) throw new Error(`README license needs renewed review: ${identity}`);
        notices.push(readme);
        noticeSource = "upstream-readme";
      } else if (identity === "@epic-web/invariant@1.0.0") {
        const declaration = notice(join(directory, "package.json"));
        const readme = notice(join(directory, "README.md"));
        if (declaration.sha256 !== "7ea6214732ffa08ae74509ba2a86d58e04a70e500933ad9c885fde92000a6503" ||
            readme.sha256 !== "cc2268af129c704007091211aa24976fb884d7278905f6222f44ea47756514fc") {
          throw new Error("Invariant's upstream declaration needs renewed review");
        }
        notices.push(declaration, readme, notice("/app/third-party-notices/epic-web-invariant-1.0.0.txt"));
        noticeSource = "upstream-metadata-with-redistributor-notice";
      } else throw new Error(`Missing package notice: ${path}`);
    }
    npmPackages.push({ name: metadata.name, version: metadata.version, license: metadata.license, noticeSource, notices });
  }
}
console.log(JSON.stringify({ nodeVersion: process.version, nodeNotice, projectNotice, commonNotices, osPackages, npmPackages }));
