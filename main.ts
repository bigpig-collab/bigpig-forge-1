// main.ts — entrypoint: bind an ephemeral port, register it with the suite
// environment, then long-poll /done until the suite is over and exit 0.
// Written from scratch for this entry. Node 22 built-ins only.

import { createForgeServer } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`register failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
        if (body && body.done === true) return;
      }
    } catch {
      // The environment may not be up yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createForgeServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not determine the bound port'));
    });
  });
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl === '') {
    // Bare local run (no suite environment): serve until killed.
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL set)`);
    return;
  }
  await register(envUrl, port);
  console.log(`forge registered on port ${port}; waiting for /done`);
  await waitForDone(envUrl);
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
