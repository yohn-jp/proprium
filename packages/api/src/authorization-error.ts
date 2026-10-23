/** Public HTTP classification only; never forward provider messages or credentials. */
export interface AuthorizationFailure {
  status: 401 | 403 | 502 | 503;
  code: string;
  message: string;
}

export function authorizationFailure(error: unknown, permission: "read" | "write"): AuthorizationFailure {
  const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 401) return { status, code: "UNAUTHORIZED", message: "Hosted repository access is invalid or expired" };
  if (status === 403) return {
    status,
    code: permission === "write" ? "WRITE_PERMISSION_REQUIRED" : "FORBIDDEN",
    message: "Current repository permission is required",
  };
  return {
    status: status === 502 ? 502 : 503,
    code: "AUTHORIZATION_UNAVAILABLE",
    message: "Hosted authorization is temporarily unavailable",
  };
}
