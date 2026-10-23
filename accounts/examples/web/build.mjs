import { build } from 'esbuild';
await build({ entryPoints: [new URL('./app.js', import.meta.url).pathname], outfile: new URL('./dist/app.js', import.meta.url).pathname, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: false, logLevel: 'silent' });
process.stdout.write('ACCOUNT_WEB_BUILT\n');
