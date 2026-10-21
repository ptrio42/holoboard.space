import { createAccountServer, createNodeAccountListener } from '@holoboard/accounts-server';
import { loadServiceConfiguration, createDevelopmentCapture, serveAccountApplication } from '../apps/service/dist/main.js';

// This host supplies its own HTTP integration without importing Holoboard or a UI.
try {
  const config = await loadServiceConfiguration(process.argv[2]);
  const app = createAccountServer({
    ...config.account,
    ...(config.developmentCapturePath ? {mail: createDevelopmentCapture(config.developmentCapturePath)} : {}),
  });
  const bridge = createNodeAccountListener({handler: app.handler, baseURL: config.account.baseURL, tls: config.tls});
  const running = await serveAccountApplication(config, app, bridge);
  process.stdout.write(`ACCOUNT_EMBEDDED_LISTENING ${running.baseURL}\n`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(() => process.stdout.write('ACCOUNT_STOPPED\n'), () => {
      process.stderr.write('ACCOUNT_SHUTDOWN_INCOMPLETE\n');
      process.exit(1);
    });
  });
} catch {
  process.stderr.write('ACCOUNT_EMBEDDED_FAILED\n');
  process.exitCode = 1;
}
