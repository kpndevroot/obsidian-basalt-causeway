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
