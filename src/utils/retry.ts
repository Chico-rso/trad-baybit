import { setTimeout as delay } from 'node:timers/promises';
export async function retryRead<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt + 1 >= attempts) throw err;
      await delay(Math.min(500 * 2 ** attempt, 5000) + Math.random() * 200);
    }
  }
}
