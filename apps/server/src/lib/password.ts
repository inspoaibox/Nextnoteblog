import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 32768; // scrypt 成本参数
const KEYLEN = 64;

function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: cost, r: 8, p: 1, maxmem: 256 * cost * 8 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N);
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !cost || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(cost));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码过长';
  return null;
}
