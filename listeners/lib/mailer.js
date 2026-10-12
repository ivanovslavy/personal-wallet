"use strict";
/**
 * Sending the alert.
 *
 * Relayed through the existing mail server rather than sent from the Pi directly: that server
 * already holds the SPF and DKIM records for the domain, and mail from a domestic IP with no
 * reverse DNS is spam-foldered or dropped outright. The Pi authenticates as a normal SMTP client.
 *
 * Credentials come from the environment only — never a literal in this file, and never logged.
 * A send failure is loud and retried, because an alert nobody receives is the same as no alert.
 */
const nodemailer = require("nodemailer");

class Mailer {
  /**
   * @param {object} o
   * @param {string} o.host SMTP host
   * @param {number} o.port 587 (STARTTLS) or 465 (implicit TLS)
   * @param {string} o.user
   * @param {string} o.pass
   * @param {string} o.from
   * @param {string} o.to
   * @param {(m:string,x?:object)=>void} [o.log]
   */
  constructor(o) {
    for (const k of ["host", "port", "user", "pass", "from", "to"]) {
      if (!o[k]) throw new Error(`mailer: ${k} is not set — refusing to start without a way to alert`);
    }
    this.from = o.from;
    this.to = o.to;
    this.log = o.log || (() => {});
    this.transport = nodemailer.createTransport({
      host: o.host,
      port: Number(o.port),
      secure: Number(o.port) === 465,
      auth: { user: o.user, pass: o.pass },
      requireTLS: Number(o.port) !== 465,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    });
  }

  /** Proves the credentials work before the service claims to be running. */
  async verify() {
    await this.transport.verify();
    return true;
  }

  /**
   * Sends, with a few retries. Returns true on success; never throws, because a listener must not
   * die because a mail server hiccuped — but it does report the failure to the caller's log.
   */
  async send({ subject, text, html }, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
      try {
        const info = await this.transport.sendMail({
          from: this.from,
          to: this.to,
          subject,
          text,
          html,
          // A real Date and Message-ID, as the house rule for this mail setup requires.
          date: new Date(),
          messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@gembachain.io>`,
        });
        this.log(`mail sent: ${subject}`, { messageId: info.messageId });
        return true;
      } catch (e) {
        const msg = String(e.message || e).slice(0, 300);
        this.log(`mail attempt ${i}/${attempts} failed`, { error: msg });
        if (i === attempts) return false;
        await new Promise((r) => setTimeout(r, 5_000 * i));
      }
    }
    return false;
  }
}

module.exports = { Mailer };
