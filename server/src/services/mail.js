import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { db } from '../db/index.js';

let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  transport ||= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

export async function sendMail({ to, subject, text, link }) {
  const t = getTransport();
  if (t) {
    await t.sendMail({ from: config.smtp.from, to, subject, text });
    return;
  }
  if (config.isProd && config.smtp.transport !== 'log') {
    throw new Error('SMTP is not configured; cannot send email in production');
  }
  // No SMTP: keep the message in the outbox table and write the link to the server log.
  // The log is only readable by whoever administers the server, never over HTTP.
  await db.query('insert into email_outbox (to_email, subject, body, link) values ($1,$2,$3,$4)', [to, subject, text, link || null]);
  if (!config.isTest) console.log(`[mail:${config.isProd ? 'log' : 'dev'}] to=${to} subject="${subject}"${link ? ` link=${link}` : ''}`);
}
