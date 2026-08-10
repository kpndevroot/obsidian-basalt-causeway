/**
 * Stand-in for the `obsidian` module at test time only (wired up in `vitest.config.ts`).
 *
 * Deliberately tiny: it provides the three *runtime* values the engine imports and nothing
 * else. Every type still resolves to the real `obsidian` package under tsc, so this file
 * cannot paper over an API that changed shape — a wrong signature is a typecheck failure,
 * not a green test.
 */

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Every `Notice` the code under test raised, so tests can assert what the user was told. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string | DocumentFragment) {
    notices.push(String(message));
  }

  setMessage(): this {
    return this;
  }

  hide(): void {}
}

export function clearNotices(): void {
  notices.length = 0;
}

/**
 * Stand-in for Obsidian's HTTP, so `transport.ts` is reachable from a test at all.
 *
 * Queued responses rather than a fixed one: the thing worth asserting about the transport is that
 * it passes `throw: false` and hands 4xx back as a value — the behaviour the whole error taxonomy
 * depends on — and that needs a failing status to be observable.
 */
export type RequestUrlCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
};

export const requestUrlCalls: RequestUrlCall[] = [];
let queued: { status: number; headers: Record<string, string>; text: string }[] = [];
let failNext: Error | null = null;

export function queueResponse(res: {
  status: number;
  headers?: Record<string, string>;
  text?: string;
}): void {
  queued.push({ status: res.status, headers: res.headers ?? {}, text: res.text ?? '' });
}

export function failRequest(err: Error): void {
  failNext = err;
}

export function clearRequests(): void {
  requestUrlCalls.length = 0;
  queued = [];
  failNext = null;
}

export async function requestUrl(req: RequestUrlCall): Promise<{
  status: number;
  headers: Record<string, string>;
  text: string;
}> {
  requestUrlCalls.push(req);
  if (failNext) {
    const err = failNext;
    failNext = null;
    throw err;
  }
  return queued.shift() ?? { status: 200, headers: {}, text: '{}' };
}
