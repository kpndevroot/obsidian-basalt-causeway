/**
 * The git blob object id of a file's bytes — ported verbatim from Basalt's
 * `src/utils/gitBlobSha.ts` so both ends of the loop compute file identity identically.
 * If these two implementations ever disagree, every file looks permanently diverged.
 *
 * Git ids a blob as the SHA-1 of `"blob " + byteLength + "\0" + contentBytes` (the header
 * length is the *byte* length, not the character count), so this matches `git hash-object`
 * exactly and is NUL-safe by construction.
 *
 * `crypto.subtle.digest('SHA-1', …)` exists in both Electron and Obsidian mobile and would
 * work, but it is async — which would push `async` through the pure planner in `sync/plan.ts`
 * for no gain. A synchronous hash keeps the planner a plain function of its inputs.
 */

function toHex(word: number): string {
  return (word >>> 0).toString(16).padStart(8, '0');
}

function sha1(bytes: Uint8Array): string {
  const msgLenBits = bytes.length * 8;

  // Pad to a whole number of 512-bit blocks: original bytes, a 0x80 terminator, zero fill,
  // then the 64-bit big-endian bit length in the final 8 bytes. `+ 9` accounts for the
  // terminator plus the length field so `ceil` never under-allocates.
  const blockCount = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(msgLenBits / 0x100000000));
  view.setUint32(padded.length - 4, msgLenBits >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let block = 0; block < blockCount; block += 1) {
    const base = block * 64;
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(base + i * 4);
    }
    for (let i = 16; i < 80; i += 1) {
      const v = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (v << 1) | (v >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

export function gitBlobSha(content: string | Uint8Array): string {
  const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const header = new TextEncoder().encode(`blob ${body.length}\0`);

  const full = new Uint8Array(header.length + body.length);
  full.set(header, 0);
  full.set(body, header.length);

  return sha1(full);
}
