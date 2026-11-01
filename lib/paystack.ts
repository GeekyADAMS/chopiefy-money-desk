const BASE_URL = "https://api.paystack.co";

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PaystackError";
  }
}

// Paystack wraps every response as { status, message, data }. Amounts are integer kobo (NGN x 100).
// A timeout throws a TimeoutError, not a PaystackError: the outcome is unknown, so callers must
// look the operation up again instead of assuming it failed.
export async function paystack<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const key = process.env.PAYSTACK_SECRET_KEY;
  // ponytail: test keys only, per the exercise rules. Going live means lifting this guard deliberately.
  if (!key?.startsWith("sk_test_")) throw new Error("PAYSTACK_SECRET_KEY must be a Paystack test key (sk_test_...)");

  const res = await fetch(BASE_URL + path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || json?.status !== true) {
    throw new PaystackError(json?.message ?? `Paystack HTTP ${res.status}`, res.status, json);
  }
  return json.data as T;
}

export const toKobo = (naira: number): number => Math.round(naira * 100);
export const toNaira = (kobo: number): number => kobo / 100;
