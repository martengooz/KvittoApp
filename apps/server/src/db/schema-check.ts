/**
 * Boot-time guard against the two schema definitions falling out of sync.
 *
 * The DDL in `index.ts` is what actually creates the tables; the Drizzle
 * tables in `schema.ts` are what every query and type is built from. Nothing
 * keeps the two mechanically aligned — there is deliberately no migration
 * tool that could (see the comment at the top of `index.ts`) — so this walks
 * every Drizzle table definition and checks it against what SQLite actually
 * has. A mismatch throws at startup, naming the table and the column, rather
 * than surfacing as a confusing failure the first time some unrelated query
 * touches it.
 */

import type Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

import * as schema from './schema.ts';

const ALL_TABLES: SQLiteTable[] = [
  schema.accounts,
  schema.devices,
  schema.pairingCodes,
  schema.serverSettings,
  schema.extractionJobs,
  schema.blobs,
  ...Object.values(schema.ENTITY_TABLES),
];

export function assertSchemaMatchesDatabase(database: Database.Database): void {
  for (const table of ALL_TABLES) {
    const { name, columns } = getTableConfig(table);
    const actual = new Set(
      (database.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((row) => row.name),
    );

    for (const column of columns) {
      if (!actual.has(column.name)) {
        throw new Error(
          `Schema drift: table "${name}" is missing column "${column.name}", which db/schema.ts declares. ` +
            'The DDL in db/index.ts and the Drizzle table in db/schema.ts have fallen out of sync.',
        );
      }
    }

    const expected = new Set(columns.map((column) => column.name));
    for (const actualName of actual) {
      if (!expected.has(actualName)) {
        throw new Error(
          `Schema drift: table "${name}" has column "${actualName}" that db/schema.ts does not declare. ` +
            'The DDL in db/index.ts and the Drizzle table in db/schema.ts have fallen out of sync.',
        );
      }
    }
  }
}
