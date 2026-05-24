import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const SCHEMA_PATH = path.resolve(process.cwd(), 'supabase/migrations/20251201000000_schema_init.sql');

function needsSsl(connectionString: string) {
  return !/sslmode=disable/i.test(connectionString);
}

function stripSslModeParam(connectionString: string) {
  // Some drivers/envs treat `sslmode=require` inconsistently. We control SSL via `Client({ ssl })`.
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryableConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timeout')
  );
}

/**
 * Conecta com retry/backoff, recriando o Client a cada tentativa.
 * Isso evita o erro: "Client has already been connected. You cannot reuse a client."
 */
async function connectClientWithRetry(
  createClient: () => Client,
  opts?: { maxAttempts?: number; initialDelayMs?: number }
): Promise<Client> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const initialDelayMs = opts?.initialDelayMs ?? 3000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      try {
        await client.end().catch(() => undefined);
      } catch {
        // ignore
      }

      if (!isRetryableConnectError(err) || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[migrations] Conexão falhou (${msg}), tentativa ${attempt}/${maxAttempts}. Aguardando ${Math.round(
          delayMs / 1000
        )}s...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Falha ao conectar ao banco de dados'));
}

/**
 * Verifica se o Storage do Supabase está pronto (storage.buckets existe).
 * Em deployments Railway/custom, o schema storage pode não estar disponível via DB direto.
 * Nesse caso, apenas loga um aviso e continua — as migrations de schema não dependem de Storage.
 */
async function waitForStorageReady(client: Client, opts?: { timeoutMs?: number; pollMs?: number }) {
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 30_000;
  const pollMs = typeof opts?.pollMs === 'number' ? opts?.pollMs : 4_000;
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await client.query<{ ready: boolean }>(
        `select (to_regclass('storage.buckets') is not null) as ready`
      );
      const ready = Boolean(r?.rows?.[0]?.ready);
      if (ready) return;
    } catch {
      // keep polling on transient errors
    }
    await sleep(pollMs);
  }

  // Storage API is not reachable via direct DB connection (common in Railway/custom deployments).
  // Log a warning and continue — schema migrations do not depend on storage.buckets being present.
  console.warn(
    '[migrations] Supabase Storage schema not detected via direct DB connection. ' +
    'Skipping storage readiness check and proceeding with migrations. ' +
    'This is expected in Railway and other non-Supabase-managed deployments.'
  );
}

/**
 * Função pública `runSchemaMigration` do projeto.
 */
export async function runSchemaMigration(dbUrl: string) {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const normalizedDbUrl = stripSslModeParam(dbUrl);

  const createClient = () =>
    new Client({
      connectionString: normalizedDbUrl,
      // NOTE: Supabase DB uses TLS; on some networks a MITM/corporate proxy can inject a cert chain
      // that Node doesn't trust. For the installer/migrations step we prefer "no-verify" over failure.
      ssl: needsSsl(dbUrl) ? { rejectUnauthorized: false } : undefined,
    });

  const client = await connectClientWithRetry(createClient, { maxAttempts: 5, initialDelayMs: 3000 });

  try {
    // Best-effort storage readiness check — continues even if Storage API is unreachable.
    await waitForStorageReady(client);
    await client.query(schemaSql);
  } finally {
    await client.end();
  }
}
