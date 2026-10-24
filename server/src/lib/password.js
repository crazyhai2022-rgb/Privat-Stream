import crypto from 'node:crypto';

// Argon2id password hashing.
// Uses the native `argon2` module when it loads. On older Linux servers (e.g. shared cPanel
// hosting with glibc < 2.34) its prebuilt binary cannot load, so we fall back to `hash-wasm`,
// a pure WebAssembly implementation. Both produce and verify the same standard
// "$argon2id$v=19$m=...,t=...,p=...$salt$hash" strings, so hashes are interchangeable.
const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

let implPromise;
const getImpl = () => (implPromise ||= resolveImpl());

async function resolveImpl() {
  try {
    const { default: argon2 } = await import('argon2');
    const opts = { type: argon2.argon2id, ...PARAMS };
    await argon2.hash('probe', opts); // make sure the native binary actually works
    return {
      hash: (pw) => argon2.hash(pw, opts),
      verify: (hash, pw) => argon2.verify(hash, pw),
    };
  } catch {
    const { argon2id, argon2Verify } = await import('hash-wasm');
    return {
      hash: (pw) => argon2id({
        password: pw,
        salt: crypto.randomBytes(16),
        parallelism: PARAMS.parallelism,
        iterations: PARAMS.timeCost,
        memorySize: PARAMS.memoryCost,
        hashLength: 32,
        outputType: 'encoded',
      }),
      verify: (hash, pw) => argon2Verify({ password: pw, hash }),
    };
  }
}

export const hashPassword = async (pw) => (await getImpl()).hash(pw);
export const verifyPassword = async (hash, pw) => {
  try { return await (await getImpl()).verify(hash, pw); } catch { return false; }
};
// A fixed hash used to keep login timing similar for unknown emails.
let dummy;
export const dummyVerify = async (pw) => {
  dummy ||= await hashPassword('not-a-real-password');
  await verifyPassword(dummy, pw);
};
