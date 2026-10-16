export class UnionFind {
  private readonly parent = new Map<number, number>();
  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x) ?? x;
    if (p !== x) this.parent.set(x, this.find(p));
    return this.parent.get(x) ?? x;
  }
  union(x: number, y: number): void {
    const left = this.find(x); const right = this.find(y);
    if (left !== right) this.parent.set(left, right);
  }
}
