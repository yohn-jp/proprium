interface SumRequest {
  readonly left: number;
  readonly right: number;
}

function parseRequest(raw: string): SumRequest {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new Error("Request must be JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be an object");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || typeof fields.left !== "number" || !Number.isFinite(fields.left) ||
      typeof fields.right !== "number" || !Number.isFinite(fields.right)) {
    throw new Error("Request must contain finite left and right numbers");
  }
  const result = fields.left + fields.right;
  if (!Number.isFinite(result)) throw new Error("Sum exceeds the numeric range");
  return { left: fields.left, right: fields.right };
}

export const guest = {
  initialize(): void {},
  invoke(raw: string): string {
    const { left, right } = parseRequest(raw);
    return JSON.stringify({ result: left + right });
  },
  dispose(): void {},
};
