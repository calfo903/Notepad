/** Shared response helpers for the Edge endpoints. */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders: Record<string, string> = {}
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };

  return jsonResponse(status, body, extraHeaders);
}

/** Read and parse a JSON body, returning null when it is absent or malformed. */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
