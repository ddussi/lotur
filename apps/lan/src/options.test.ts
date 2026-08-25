import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import test from "node:test";

import { parseLanArguments, selectLanHost } from "./options.ts";

test("LAN 공유 인자는 로컬 origin과 자동 포트를 기본값으로 사용한다", () => {
  assert.deepEqual(parseLanArguments(["http://127.0.0.1:3000"]), {
    kind: "run",
    localOrigin: "http://127.0.0.1:3000",
    port: 0,
  });
  assert.deepEqual(parseLanArguments(["--help"]), { kind: "help" });
});

test("LAN 공유 인자는 명시한 사설 IP와 포트를 검증한다", () => {
  assert.deepEqual(parseLanArguments([
    "http://localhost:5173",
    "--host",
    "192.168.1.20",
    "--port",
    "8787",
  ]), {
    kind: "run",
    localOrigin: "http://localhost:5173",
    host: "192.168.1.20",
    port: 8787,
  });
  assert.throws(
    () => parseLanArguments(["http://127.0.0.1:3000", "--host", "8.8.8.8"]),
    /private IPv4/,
  );
  assert.throws(
    () => parseLanArguments(["http://127.0.0.1:3000", "--port", "70000"]),
    /port/,
  );
  assert.throws(
    () => parseLanArguments(["https://127.0.0.1:3000"]),
    /local origin/,
  );
});

test("LAN 주소 자동 선택은 실제 Wi-Fi 주소를 가상 어댑터보다 우선한다", () => {
  const interfaces = {
    lo0: [interfaceInfo("127.0.0.1", true)],
    docker0: [interfaceInfo("172.17.0.1")],
    en0: [interfaceInfo("192.168.0.23")],
  };
  assert.deepEqual(selectLanHost(interfaces), {
    host: "192.168.0.23",
    interfaceName: "en0",
  });
  assert.deepEqual(selectLanHost(interfaces, "172.17.0.1"), {
    host: "172.17.0.1",
    interfaceName: "docker0",
  });
  assert.throws(
    () => selectLanHost(interfaces, "192.168.0.99"),
    /not assigned/,
  );
  assert.throws(
    () => selectLanHost({ lo0: [interfaceInfo("127.0.0.1", true)] }),
    /private IPv4/,
  );
  assert.throws(
    () => selectLanHost({ docker0: [interfaceInfo("172.17.0.1")] }),
    /Wi-Fi\/LAN/,
  );
});

function interfaceInfo(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}
