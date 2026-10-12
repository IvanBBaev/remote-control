/** The ten tables of 02 §5.6, plus `invite_codes` (02 §5.7, M0-09). */
export const RELAY_TABLES = [
  'users',
  'passkeys',
  'recovery_codes',
  'devices',
  'pairings',
  'push_subscriptions',
  'sessions',
  'agent_tokens',
  'pairing_slots',
  'audit_log',
  'invite_codes',
] as const;

/** Column names that would suggest a stored payload (invariant I3). */
export const FORBIDDEN_COLUMNS: readonly string[] = ['payload', 'body', 'ciphertext', 'content'];

export interface IntrospectedColumn {
  readonly table: string;
  readonly name: string;
  readonly type: string;
}

export interface IntrospectedSchema {
  /** Base tables of the application schemas, sorted (drizzle's bookkeeping excluded). */
  readonly tables: string[];
  /** Every column in every non-system schema, drizzle's bookkeeping included. */
  readonly columns: IntrospectedColumn[];
}

const USER_SCHEMAS = "table_schema NOT IN ('pg_catalog', 'information_schema')";

/** Reads the live schema from information_schema (not from the TypeScript schema). */
export async function introspectSchema(
  query: (text: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<IntrospectedSchema> {
  const tables = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE ${USER_SCHEMAS} AND table_schema <> 'drizzle' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const columns = await query(
    `SELECT table_schema || '.' || table_name AS table_name, column_name, data_type
     FROM information_schema.columns WHERE ${USER_SCHEMAS}
     ORDER BY table_name, column_name`,
  );
  return {
    tables: tables.map((row) => String(row['table_name'])),
    columns: columns.map((row) => ({
      table: String(row['table_name']),
      name: String(row['column_name']),
      type: String(row['data_type']),
    })),
  };
}
