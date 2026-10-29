import http from 'node:http';
import { apply } from '../index.js';

const route = { handler: null };
const ctx = {
  logger: { info() {}, warn: console.warn, error: console.error },
  webServer: {
    register(definition) {
      route.handler = definition.handler;
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
  effect(factory) {
    const disposer = factory();
    return () => { if (typeof disposer === 'function') disposer(); };
  },
};

await apply(ctx);

if (!route.handler) throw new Error('route not registered');
const port = Number(process.env.TEST_PORT || 7788);
const server = http.createServer((req, res) => route.handler(req, res));
server.listen(port, '127.0.0.1', () => {
  console.log(`harness listening on http://127.0.0.1:${port}`);
});
