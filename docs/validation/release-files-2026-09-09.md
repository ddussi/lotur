# Release candidate file validation — 2026-09-09

This records an early private candidate, not the final alpha or a published release.

- Source: `1823216b6d6d0c5463c18d6c10debe74b4aca024`; version `0.1.0-alpha.1`.
- [Linux CI run](https://github.com/ddussi/lotur/actions/runs/34255208065): verification passed; production publication and deployment were skipped.
- The run passed 68 script tests, 359 application/PostgreSQL tests, 19 framework browser cases, and 3 demo/installed-Client browser cases. No tests were skipped. Production dependency audit reported zero vulnerabilities; all six runtime targets built and passed the entrypoint checks.
- `pack:release` was run twice from the clean source commit on macOS with Node 24.12.0. All eight output files were byte-identical between builds.
- The Linux CI artifact was downloaded and its version/commit subdirectory was checked with `verify:release --commit` against the full source SHA. All eight files were also byte-identical to the macOS output: three installable archives, source archive, LICENSE, CHANGELOG, manifest, and checksums. Total file bytes: 673,953 (excluding the Actions ZIP wrapper).
- This comparison establishes the observed reproducibility of this candidate across these two builds and CI, not a general guarantee for all future dependencies or tool versions. The checksum file is an integrity check, not independent origin authentication.

The production connection settings were separately changed to use Secrets in a later commit; their masked behavior in an actual deployment is still a final deployment check. Runtime registry digests, data restoration, product media, support guidance, and the final HTTPS candidate gate remain tracked in the [alpha plan](../open-source-alpha-plan.md).
