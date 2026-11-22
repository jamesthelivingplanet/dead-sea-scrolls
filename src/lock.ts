/** FIFO async mutex. A rejected fn releases the lock. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
