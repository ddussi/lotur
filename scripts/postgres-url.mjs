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
  return { target, databaseName };
}

export function postgresEnvironment(targetUrl, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  environment.PGHOST = targetUrl.hostname;
  environment.PGPORT = targetUrl.port || "5432";
  environment.PGDATABASE = decodeURIComponent(targetUrl.pathname.replace(/^\//, ""));
  environment.PGUSER = decodeURIComponent(targetUrl.username);
  environment.PGPASSWORD = decodeURIComponent(targetUrl.password);
  const supportedParameters = new Map([
    ["sslmode", "PGSSLMODE"],
    ["sslrootcert", "PGSSLROOTCERT"],
    ["sslcert", "PGSSLCERT"],
    ["sslkey", "PGSSLKEY"],
    ["connect_timeout", "PGCONNECT_TIMEOUT"],
    ["target_session_attrs", "PGTARGETSESSIONATTRS"],
    ["application_name", "PGAPPNAME"],
  ]);
  for (const [name, value] of targetUrl.searchParams) {
    const environmentName = supportedParameters.get(name);
    if (environmentName === undefined) {
      throw new Error(`unsupported PostgreSQL URL parameter: ${name}`);
    }
    environment[environmentName] = value;
  }
  return environment;
}
