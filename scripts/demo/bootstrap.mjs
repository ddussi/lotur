import { Pool } from "pg";
import { AuthService, Argon2idPasswordHasher } from "../../packages/auth/src/index.ts";
import { PostgresAuthRepository } from "../../packages/storage-postgres/src/index.ts";

export function databaseUrl(config, migration = false) {
  const username = migration ? "demo_migrator" : "demo_runtime";
  const password = migration ? config.databasePassword : config.runtimePassword;
  return `postgres://${username}:${password}@127.0.0.1:${config.databasePort}/review_tunnel_demo`;
}

export async function initializeDemo({ config, save, runMigrations, signal, log }) {
  const options = { max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 };
  const migration = new Pool({ ...options, connectionString: databaseUrl(config, true) });
  let runtime;
  try {
    await migration.query(`CREATE TABLE IF NOT EXISTS rt_demo_identity (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), instance_id text NOT NULL
    )`);
    await migration.query("INSERT INTO rt_demo_identity(instance_id) VALUES ($1) ON CONFLICT DO NOTHING", [config.id]);
    const identity = await migration.query("SELECT instance_id FROM rt_demo_identity");
    if (identity.rows.length !== 1 || identity.rows[0].instance_id !== config.id) {
      throw new Error("This database belongs to another demo. It was not migrated or reset.");
    }
    signal.throwIfAborted();
    await runMigrations();
    if (!(await migration.query("SELECT 1 FROM pg_roles WHERE rolname = 'demo_runtime'")).rowCount) {
      // The configuration validator accepts only generated base64url secrets.
      await migration.query(`CREATE ROLE demo_runtime LOGIN PASSWORD '${config.runtimePassword}'`);
    }
    await migration.query(`
      GRANT USAGE ON SCHEMA public TO demo_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO demo_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO demo_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE demo_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO demo_runtime;
      ALTER DEFAULT PRIVILEGES FOR ROLE demo_migrator IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO demo_runtime;
    `);
    runtime = new Pool({ ...options, connectionString: databaseUrl(config) });
    const repository = new PostgresAuthRepository(runtime);
    const hasher = new Argon2idPasswordHasher();
    let creatingUsername;
    config.pendingPasswords ??= {};
    const service = new AuthService({
      repository,
      passwordHasher: {
        async hash(password) {
          if (creatingUsername) {
            // Persist before the account INSERT so an interrupted setup can finish
            // the normal temporary-password change on the next run.
            config.pendingPasswords[creatingUsername] = password;
            await save();
          }
          return hasher.hash(password);
        },
        verify: (hash, password) => hasher.verify(hash, password),
      },
      sessionHmacKey: Buffer.from(config.hmacKey, "base64url"),
      dummyPasswordHash: await hasher.hash("unused-local-demo-dummy-password"),
      authenticationEventSink: {
        write(event) { log.write(`[demo-account] ${JSON.stringify(event)}\n`); },
        reportFailure() { log.write("Demo account event could not be recorded.\n"); },
      },
    });
    async function prepareAccount(username, roles, actor) {
      signal.throwIfAborted();
      let account = await repository.findAccountByUsername(username);
      if (!account) {
        creatingUsername = username;
        try {
          const created = actor
            ? await service.createAccount(actor, { username, displayName: `Demo ${username}`, roles })
            : await service.bootstrapAdministrator({ username, displayName: "Demo administrator" });
          account = created.account;
        } finally { creatingUsername = undefined; }
      }
      if (!account.enabled || roles.some(role => !account.roles.includes(role))) {
        throw new Error(`The reserved ${username} demo account was changed. Its data and permissions were preserved.`);
      }
      if (account.mustChangePassword) {
        const currentPassword = config.pendingPasswords[username];
        if (!currentPassword) throw new Error(`The ${username} account requires its temporary password. Existing data was preserved.`);
        const login = await service.authenticate({ username, password: currentPassword, remoteAddress: "local-demo-setup" });
        await service.changeOwnPassword(login.principal, { currentPassword, newPassword: config.passwords[username] });
      }
      delete config.pendingPasswords[username];
      await save();
    }
    await prepareAccount("admin", ["ADMIN"]);
    const admin = await service.verifyAdministratorCredentials({
      username: "admin", password: config.passwords.admin, remoteAddress: "local-demo-setup",
    });
    await prepareAccount("developer", ["DEVELOPER"], admin);
    await prepareAccount("reviewer", ["REVIEWER"], admin);
  } finally {
    await runtime?.end();
    await migration.end();
  }
}
