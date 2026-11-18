import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'; // gforge:allow — base-36 alphabet, not a secret

/**
 * Time-sortable, URL/topic-safe id: `<prefix>_<10 chars time><12 chars random>`.
 * Sort order matches creation order at millisecond granularity.
 */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 36] + time;
    t = Math.floor(t / 36);
  }
  const bytes = randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `${prefix}_${time}${rand}`;
}
