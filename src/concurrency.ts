export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 4;

export function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(value)));
}

export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Math.min(clampConcurrency(limit), items.length);
  const runLane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next++;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));
}

export function walkTree<T>(roots: T[], limit: number, visit: (item: T) => Promise<T[]>): Promise<void> {
  const queue = [...roots];
  const lanes = clampConcurrency(limit);
  let active = 0;
  let failed = false;

  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (failed) return;
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < lanes && queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        active++;
        visit(item).then(
          (children) => {
            active--;
            queue.push(...children);
            pump();
          },
          (error: unknown) => {
            failed = true;
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    };
    pump();
  });
}

export class Serial {
  private tail: Promise<void> = Promise.resolve();

  run(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
