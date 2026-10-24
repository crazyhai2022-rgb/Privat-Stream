import argon2 from 'argon2';

const opts = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw) => argon2.hash(pw, opts);
export const verifyPassword = async (hash, pw) => {
  try { return await argon2.verify(hash, pw); } catch { return false; }
};
// A fixed hash used to keep login timing similar for unknown emails.
let dummy;
export const dummyVerify = async (pw) => {
  dummy ||= await argon2.hash('not-a-real-password', opts);
  await verifyPassword(dummy, pw);
};
