/** A later selection invalidates every completion belonging to an older one. */
export class LatestRequest {
  private generation = 0;

  begin() {
    const generation = ++this.generation;
    return () => generation === this.generation;
  }

  invalidate() {
    this.generation += 1;
  }
}
