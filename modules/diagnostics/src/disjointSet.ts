export class UnionFind {
  private parent: Map<number, number> = new Map();

  find(x: number): number {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
    }
    const p = this.parent.get(x) ?? x;
    if (p !== x) {
      this.parent.set(x, this.find(p));
    }
    return this.parent.get(x) ?? x;
  }

  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px !== py) {
      this.parent.set(px, py);
    }
  }
}
