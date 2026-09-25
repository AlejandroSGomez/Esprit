/** Share overlapping reads so a native catalogue is published only once. */
export function coalescedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(read).finally(() => { pending = null; });
    }
    return pending;
  };
}
