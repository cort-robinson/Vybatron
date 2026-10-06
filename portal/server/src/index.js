import { loadConfig } from './config.js';
import { createPortalServer } from './app.js';

let app;
try {
  app = await createPortalServer(loadConfig());
  await app.listen();
  console.log('Vybertron portal is listening.');
} catch {
  // Do not print upstream exceptions, environment values, request URLs or tokens.
  console.error('Vybertron portal startup failed. Check configuration and private auth storage.');
  await app?.close(); process.exitCode = 1;
}

if (app && !process.exitCode) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await app.close();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
