import { backupAccountDatabase, restoreAccountDatabase, reconcileAccountRestore, rotateAccountStorageKey } from '@holoboard/accounts-server';
import { loadServiceConfiguration } from '../apps/service/dist/main.js';

// Offline local operator command. Secret material is read through private config files.
try {
  const [command, sourceConfigPath, argument, targetConfigPath, ...extra] = process.argv.slice(2);
  if (extra.length || !sourceConfigPath) throw new Error();
  const config = await loadServiceConfiguration(sourceConfigPath);
  if (command === 'backup' && argument && !targetConfigPath) {
    await backupAccountDatabase(config.account.databasePath, argument);
  } else if (command === 'restore' && argument && targetConfigPath) {
    const target = await loadServiceConfiguration(targetConfigPath);
    const result = await restoreAccountDatabase({ backupPath: argument, targetPath: target.account.databasePath, currentAuthSecret: config.account.secret, newAuthSecret: target.account.secret, custody: target.account.custody });
    if (!result.ready) { process.stdout.write('ACCOUNT_RESTORE_QUARANTINED\n'); process.exitCode = 2; }
  } else if (command === 'reconcile' && !argument && !targetConfigPath) {
    await reconcileAccountRestore(config.account.databasePath, config.account.custody);
  } else if (command === 'rotate' && !argument && !targetConfigPath) {
    await rotateAccountStorageKey(config.account.databasePath, config.account.custody);
  } else throw new Error();
  if (!process.exitCode) process.stdout.write('ACCOUNT_MAINTENANCE_COMPLETE\n');
} catch { process.stderr.write('ACCOUNT_MAINTENANCE_FAILED\n'); process.exitCode = 1; }
