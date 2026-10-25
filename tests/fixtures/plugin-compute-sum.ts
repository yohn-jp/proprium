interface SumRequest {
  readonly left: number;
  readonly right: number;
}

export const guest = {
  initialize(): void {},
  invoke(raw: string): string {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be an object");
    const request = value as Record<string, unknown>;
    if (Object.keys(request).length !== 2 || typeof request.left !== "number" || !Number.isFinite(request.left) ||
        typeof request.right !== "number" || !Number.isFinite(request.right)) throw new Error("Request must contain two finite numbers");
    const sum = (request.left as number) + (request.right as number);
    if (!Number.isFinite(sum)) throw new Error("Sum exceeds numeric range");
    return JSON.stringify({ result: sum });
  },
  dispose(): void {},
};
