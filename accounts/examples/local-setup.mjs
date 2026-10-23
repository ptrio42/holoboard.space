import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

// Explicit local installation setup. Serving never invokes this helper.
try {
  const [directory, portText = '3443'] = process.argv.slice(2);
  const port = Number(portText);
  if (!directory || !isAbsolute(directory) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error();
  await access(directory, constants.F_OK).then(() => {throw new Error();}, error => {if(error.code !== 'ENOENT') throw error;});
  await mkdir(directory, {mode: 0o700});
  const write = (name, text) => writeFile(join(directory, name), text, {mode: 0o600, flag: 'wx'});
  await write('auth-secret', randomBytes(48).toString('base64url'));
  await write('keyring.json', JSON.stringify({activeKid:'local', keys:{local:randomBytes(32).toString('hex')}}));
  await write('openssl.cnf', '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  const previous = process.umask(0o077);
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','7','-keyout',join(directory,'tls-key.pem'),'-out',join(directory,'tls-cert.pem'),'-config',join(directory,'openssl.cnf')], {stdio:'ignore'});
  } finally {process.umask(previous);}
  const baseURL = `https://127.0.0.1:${port}`;
  await write('config.json', JSON.stringify({databasePath:join(directory,'accounts.sqlite'),baseURL,
    trustedOrigins:[baseURL],returnURLs:[`${baseURL}/complete`],installationId:randomBytes(16).toString('hex'),inventoryPath:join(directory,'inventory'),
    authSecretPath:join(directory,'auth-secret'),keyringPath:join(directory,'keyring.json'),tls:{keyPath:join(directory,'tls-key.pem'),certPath:join(directory,'tls-cert.pem')},
    listenHost:'127.0.0.1',port,explicitExportEnabled:true,developmentCapturePath:join(directory,'mail.jsonl'),mailIntervalMs:1000,shutdownTimeoutMs:10000,
  },null,2)+'\n');
  process.stdout.write('ACCOUNT_LOCAL_CONFIGURATION_CREATED\n');
} catch {
  process.stderr.write('ACCOUNT_LOCAL_SETUP_FAILED\n');process.exitCode=1;
}
