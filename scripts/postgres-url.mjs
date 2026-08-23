export function parsePostgresTarget(value, variableName) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use postgres:// or postgresql://`);
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (databaseName === "") throw new Error(`${variableName} must include a database name`);
  const host = normalizePostgresHost(target.hostname);
  if (host === "") throw new Error(`${variableName} must include an explicit PostgreSQL host`);
  if (host.includes(",")) {
    throw new Error(`${variableName} must identify a single PostgreSQL host`);
  }
  const port = target.port || "5432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error(`${variableName} must include a valid PostgreSQL port`);
  }
  return { target, databaseName, host, port };
}

export function postgresEnvironment(targetUrl, baseEnvironment = process.env) {
  const environment = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (baseEnvironment[name] !== undefined) environment[name] = baseEnvironment[name];
  }
  environment.PGHOST = normalizePostgresHost(targetUrl.hostname);
  environment.PGPORT = targetUrl.port || "5432";
  environment.PGDATABASE = decodeURIComponent(targetUrl.pathname.replace(/^\//, ""));
  environment.PGUSER = decodeURIComponent(targetUrl.username);
  environment.PGPASSWORD = decodeURIComponent(targetUrl.password);
  environment.PGCONNECT_TIMEOUT = "10";
  const supportedParameters = new Map([
    ["sslmode", "PGSSLMODE"],
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["connect_timeout", "PGCONNECT_TIMEOUT"],
    ["target_session_attrs", "PGTARGETSESSIONATTRS"],
    ["application_name", "PGAPPNAME"],
  ]);
  const seenParameters = new Set();
  for (const [name, value] of targetUrl.searchParams) {
    if (seenParameters.has(name)) {
      throw new Error(`duplicate PostgreSQL URL parameter: ${name}`);
    }
    seenParameters.add(name);
    const environmentName = supportedParameters.get(name);
    if (environmentName === undefined) {
      throw new Error(`unsupported PostgreSQL URL parameter: ${name}`);
    }
    if (
      name === "connect_timeout" &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 60)
    ) {
      throw new Error("connect_timeout must be an integer between 1 and 60 seconds");
    }
    environment[environmentName] = value;
  }
  return environment;
}

export function postgresTargetConfirmation(parsedTarget) {
  const host = parsedTarget.host ?? normalizePostgresHost(parsedTarget.target.hostname);
  const port = parsedTarget.port ?? (parsedTarget.target.port || "5432");
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return `${displayHost}:${port}/${parsedTarget.databaseName}`;
}

function normalizePostgresHost(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
