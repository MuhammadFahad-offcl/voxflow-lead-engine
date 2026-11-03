import { HealthResponse } from '@voxflow/shared';
import { connection } from 'next/server';
import { z } from 'zod';

// Same names and defaults as apps/api/src/main.ts; #6 gives both apps one env source.
const ApiAddressEnv = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

const env = ApiAddressEnv.parse(process.env);
const apiBaseUrl = `http://${env.API_HOST}:${String(env.API_PORT)}`;

async function readApiStatus(): Promise<string> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    const health = HealthResponse.safeParse(await response.json());
    return health.success ? health.data.status : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export default async function HomePage() {
  // Render on each request so `next build` never needs a running API.
  await connection();
  const apiStatus = await readApiStatus();

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl font-semibold">VoxFlow Lead Engine</h1>
      <p className="mt-4 text-lg">API: {apiStatus}</p>
    </main>
  );
}
