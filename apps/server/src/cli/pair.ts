#!/usr/bin/env node
/**
 * Mints a pairing code.
 *
 * Run on the server (`npm run pair`), then type the code into the app's
 * Settings screen. Codes are single-use and short-lived.
 */

import { createPairingCode, ensureDefaultAccount } from '../db/accounts.ts';
import { closeDatabase, getConnection } from '../db/index.ts';
import { config } from '../env.ts';

function main(): void {
  getConnection();
  const accountId = ensureDefaultAccount();
  const { code, expiresAt } = createPairingCode(accountId);
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);

  console.log('');
  console.log('  Parkopplingskod');
  console.log('  ───────────────');
  console.log(`      ${code}`);
  console.log('');
  console.log(`  Giltig i ${minutes} minuter, kan användas en gång.`);
  console.log(`  Server:   http://localhost:${config.port}`);
  console.log(`  Databas:  ${config.databasePath}`);
  console.log('');
  console.log('  Öppna Inställningar → Synkronisering i appen, fyll i serveradressen');
  console.log('  och koden ovan.');
  console.log('');

  closeDatabase();
}

main();
