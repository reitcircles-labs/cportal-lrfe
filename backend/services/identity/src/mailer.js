import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';

/**
 * Outgoing email (invitations). One of:
 *
 *   smtp  – send through an SMTP server (Google Workspace, Elastic Email, Microsoft 365, a local
 *           Postfix…). On port 587 the connection must upgrade to TLS (STARTTLS); 465 is TLS from
 *           the start. Credentials are never logged.
 *   file  – development: write each message as an .eml file (open it in any mail program)
 *   none  – no email; the admin passes the invitation link on (IDENTITY_EXPOSE_INVITE_LINKS=true)
 *
 * send({ to, subject, text, html }) → { sent: true, id } or throws with a message safe to show
 * an administrator (no credentials, no server internals beyond the SMTP reply).
 *
 * heloName: the name this server introduces itself with (EHLO). Use the server's FQDN: without
 * one, the client says "[127.0.0.1]" and Google's relay answers "421 Try again later".
 * family: 4 or 6 to always connect over that IP version. An SMTP relay that allows this server by
 * IP address (Google Workspace) only knows the address it was given; on a dual-stack server the
 * connection may otherwise leave over the other one and be refused ("550 5.7.1 invalid credentials").
 */
export function createMailer({
    transport = 'none', from, replyTo, host, port = 587, secure, user, password, heloName, family,
    requireTls = true, dir = './tmp/mail', timeoutMs = 15_000, transporter
} = {}) {
    if (transport === 'none') return { enabled: false, async send() { throw new Error('Email is not configured'); } };
    if (!from) throw new Error('MAIL_FROM is required when MAIL_TRANSPORT is set (e.g. "Deeds Registry <noreply@example.com>")');

    if (transport === 'file') {
        const t = transporter || nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
        return {
            enabled: true,
            describe: `files in ${dir}`,
            async send(message) {
                const info = await t.sendMail({ from, replyTo, ...message });
                await mkdir(dir, { recursive: true });
                const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.to.replace(/[^a-z0-9@._-]/gi, '_')}.eml`);
                await writeFile(file, info.message, { mode: 0o600 });
                return { sent: true, id: info.messageId, file };
            }
        };
    }

    if (transport !== 'smtp') throw new Error(`MAIL_TRANSPORT must be smtp, file or none (got "${transport}")`);
    if (!host) throw new Error('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
    if (family !== undefined && ![4, 6].includes(Number(family))) throw new Error(`SMTP_FAMILY must be 4 or 6 (got "${family}")`);
    const isSecure = secure ?? Number(port) === 465;
    const options = (address) => ({
        // with a fixed IP family, connect to that address but check the certificate against the name
        host: address || host, port: Number(port), secure: isSecure,
        ...(heloName ? { name: heloName } : {}),
        // on 587/25: refuse to send credentials or mail unless the server upgrades to TLS
        requireTLS: !isSecure && requireTls,
        auth: user ? { user, pass: password } : undefined,
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs * 2,
        tls: { minVersion: 'TLSv1.2', servername: host }
    });
    const fixed = transporter || (family ? null : nodemailer.createTransport(options()));
    /** The transport for one connection: with a fixed family, the address is looked up each time. */
    async function connect() {
        if (fixed) return fixed;
        const { address } = await lookup(host, { family: Number(family) }).catch(() => {
            throw Object.assign(new Error(`No IPv${family} address for ${host}`), { code: 'EDNS' });
        });
        return nodemailer.createTransport(options(address));
    }
    return {
        enabled: true,
        describe: `SMTP ${host}:${port}${user ? ` as ${user}` : ''}${family ? ` over IPv${family}` : ''}`,
        async send(message) {
            try {
                const info = await (await connect()).sendMail({ from, replyTo, ...message });
                return { sent: true, id: info.messageId };
            } catch (err) {
                throw new Error(smtpProblem(err));
            }
        },
        /** Connect and authenticate without sending (used at start-up to report a bad configuration early). */
        verify: async () => (await connect()).verify()
    };
}

/** A short reason an administrator can act on. */
function smtpProblem(err) {
    if (err.code === 'EAUTH') return 'The mail server refused the SMTP username or password';
    if (/\b421\b/.test(`${err.response || ''} ${err.message}`) && /EHLO|HELO/.test(`${err.command || ''} ${err.message}`)) {
        return "The mail server refused this server's greeting (421 at EHLO); set SMTP_HELO_NAME to the server's full host name (FQDN)";
    }
    if (err.code === 'ETLS' || err.command === 'STARTTLS') return 'The mail server does not offer an encrypted connection (STARTTLS), so nothing was sent; check SMTP_HOST and SMTP_PORT (587 or 465)';
    if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err.code)) return 'The mail server could not be reached';
    if (err.code === 'EENVELOPE') return `The mail server refused the address: ${err.response || err.message}`;
    if (err.responseCode) return `The mail server refused the message: ${err.response}`;
    return 'The email could not be sent';
}

/** The invitation email: plain text and a simple HTML version with the same content. */
export function invitationEmail({ name, link, expiresAt, invitedBy, roles, issuer, resend = false }) {
    const until = expiresAt.toUTCString().replace(/:\d\d GMT$/, ' UTC');
    const subject = resend ? `Your new invitation to ${issuer}` : `You have been invited to ${issuer}`;
    const text = [
        `Hello ${name},`,
        '',
        `${invitedBy} has ${resend ? 'sent you a new invitation' : 'invited you'} to the ${issuer} land records system${roles ? ` as ${roles}` : ''}.`,
        '',
        'To activate your account, open this link and choose a password (at least 12 characters):',
        link,
        '',
        `The link works once and expires on ${until}.${resend ? ' Earlier invitation links no longer work.' : ''}`,
        'At your first sign-in you will set up an authenticator app on your phone for the 6-digit codes.',
        '',
        'If you did not expect this invitation, you can ignore this email.'
    ].join('\n');
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px;margin:0 auto;padding:24px">
<p>Hello ${esc(name)},</p>
<p>${esc(invitedBy)} has ${resend ? 'sent you a new invitation' : 'invited you'} to the <b>${esc(issuer)}</b> land records system${roles ? ` as <b>${esc(roles)}</b>` : ''}.</p>
<p>To activate your account, choose a password (at least 12 characters):</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#1d4ed8;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Activate my account</a></p>
<p style="font-size:13px;color:#4b5563">Or copy this link into your browser:<br><span style="word-break:break-all">${esc(link)}</span></p>
<p style="font-size:13px;color:#4b5563">The link works once and expires on ${esc(until)}.${resend ? ' Earlier invitation links no longer work.' : ''}
At your first sign-in you will set up an authenticator app on your phone for the 6-digit codes.</p>
<p style="font-size:13px;color:#4b5563">If you did not expect this invitation, you can ignore this email.</p>
</body></html>`;
    return { subject, text, html };
}
