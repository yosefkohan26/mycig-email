import { connection as connectionSchema } from '../../db/schema';
import { connectionToDriver } from '../../lib/server-utils';
import { DurableObject } from 'cloudflare:workers';
import type { ParsedMessage } from '../../types';
import type { ZeroEnv } from '../../env';

export class ThreadSyncWorker extends DurableObject<ZeroEnv> {
  constructor(state: DurableObjectState, env: ZeroEnv) {
    super(state, env);
  }

  private getThreadKey(connectionId: string, threadId: string) {
    return `${connectionId}/${threadId}.json`;
  }

  public async syncThread(
    connection: typeof connectionSchema.$inferSelect,
    threadId: string,
  ): Promise<ParsedMessage | undefined> {
    const driver = connectionToDriver(connection);
    if (!driver) throw new Error('No driver available');

    // Gmail-era withRetry wrapper was retired with gmail-rate-limit.ts in
    // Phase 2c. Graph has its own throttling contract (429 + Retry-After);
    // the Microsoft SDK handles that transparently, so a plain await is fine.
    const thread = await driver.get(threadId);

    await this.env.THREADS_BUCKET.put(
      this.getThreadKey(connection.id, threadId),
      JSON.stringify(thread),
      {
        customMetadata: {
          threadId,
        },
      },
    );

    return thread.latest;
  }
}
