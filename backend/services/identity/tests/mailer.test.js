import { expect } from 'chai';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventBus } from '@lrfe/common';
import { IdentityService } from '../src/identity.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { seedIdentity } from '../src/seed.js';
import { createMailer, invitationEmail } from '../src/mailer.js';
import { makeClock, PASSWORD } from './helpers.js';

const ADMIN = { id: 'admin-1', name: 'Paulus Hamutenya' };

/** A mailer that records what it was asked to send, or fails like an unreachable server. */
function fakeMailer({ fail } = {}) {
    const sent = [];
    return { sent, enabled: true, async send(m) { if (fail) throw new Error(fail); sent.push(m); return { sent: true }; } };
}

async function makeService(mailer, config = {}) {
    const repo = createMemoryRepo();
    await seedIdentity(repo, { demoPassword: PASSWORD });
    const events = createEventBus({ driver: 'memory', source: 'identity' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const service = new IdentityService({ repo, events, mailer, clock: makeClock(), config });
    return { repo, service, published };
}

const linkIn = (text) => text.match(/https?:\/\/\S+token=[\w-]+/)[0];

describe('invitation email', () => {
    it('emails the invitation link; the link activates the account', async () => {
        const mailer = fakeMailer();
        const { service } = await makeService(mailer);
        const res = await service.invite({ name: 'Nangula Shikongo', email: 'N.Shikongo@deeds.gov.na', office: 'Review desk', roles: ['rev'] }, ADMIN);
        expect(res.email).to.deep.equal({ sent: true, to: 'n.shikongo@deeds.gov.na' });
        expect(res).to.not.have.property('inviteUrl');           // not exposed unless configured
        expect(mailer.sent).to.have.length(1);
        const m = mailer.sent[0];
        expect(m.to).to.equal('n.shikongo@deeds.gov.na');
        expect(m.subject).to.include('invited');
        expect(m.text).to.include('Paulus Hamutenya').and.include('Metadata reviewer');
        const link = linkIn(m.text);
        expect(m.html).to.include(link.replace(/&/g, '&amp;'));
        const token = new URL(link.replace('#/', '')).searchParams.get('token');
        await service.acceptInvite({ token, password: 'a long new password' });
        expect((await service.login({ email: 'n.shikongo@deeds.gov.na', password: 'a long new password' })).next).to.not.equal(undefined);
    });

    it('never puts the link in events or the access log', async () => {
        const mailer = fakeMailer();
        const { service, published, repo } = await makeService(mailer);
        await service.invite({ name: 'X', email: 'x@deeds.gov.na', roles: ['scan'] }, ADMIN);
        const link = linkIn(mailer.sent[0].text);
        const token = link.split('token=')[1];
        expect(JSON.stringify(published)).to.not.include(token);
        const { items } = await repo.listAccessEvents({ kind: 'user' });
        expect(JSON.stringify(items)).to.not.include(token);
        expect(items.find(e => e.action === 'Invited').detail).to.include('invitation emailed');
        expect(published.find(e => e.type === 'identity.user.invited').data).to.include({ emailSent: true });
    });

    it('still creates the user when the email fails, and says why', async () => {
        const { service, repo } = await makeService(fakeMailer({ fail: 'The mail server could not be reached' }), { exposeInviteLinks: true });
        const res = await service.invite({ name: 'Y', email: 'y@deeds.gov.na', roles: ['scan'] }, ADMIN);
        expect(res.user.status).to.equal('Invited');
        expect(res.email).to.deep.equal({ sent: false, to: 'y@deeds.gov.na', reason: 'The mail server could not be reached' });
        expect(res.inviteUrl).to.match(/token=/);                 // dev fallback: the admin passes it on
        const { items } = await repo.listAccessEvents({ kind: 'user' });
        expect(items.find(e => e.action === 'Invited').detail).to.include('not emailed: The mail server could not be reached');
    });

    it('without a mailer: not sent, reason given (today\'s behaviour)', async () => {
        const { service } = await makeService(createMailer());
        const res = await service.invite({ name: 'Z', email: 'z@deeds.gov.na', roles: ['scan'] }, ADMIN);
        expect(res.email).to.include({ sent: false, reason: 'Email is not configured on the server' });
    });

    it('resend emails a new link; the old one stops working', async () => {
        const mailer = fakeMailer();
        const { service } = await makeService(mailer);
        const { user } = await service.invite({ name: 'R', email: 'r@deeds.gov.na', roles: ['rec'] }, ADMIN);
        const res = await service.resendInvite(user.id, ADMIN);
        expect(res.email.sent).to.equal(true);
        expect(mailer.sent).to.have.length(2);
        expect(mailer.sent[1].subject).to.include('new invitation');
        const [oldToken, newToken] = mailer.sent.map(m => linkIn(m.text).split('token=')[1]);
        expect(oldToken).to.not.equal(newToken);
        try { await service.acceptInvite({ token: oldToken, password: 'a long new password' }); throw new Error('old link worked'); }
        catch (err) { expect(err.message).to.include('invalid or has expired'); }
        await service.acceptInvite({ token: newToken, password: 'a long new password' });
    });

    it('escapes names in the HTML version', () => {
        const { html, text } = invitationEmail({ name: '<script>x</script>', link: 'http://localhost/#/invite?token=t', expiresAt: new Date('2026-10-04T12:00:00Z'), invitedBy: 'A & B', roles: 'Scan operator', issuer: 'Deeds Registry Namibia' });
        expect(html).to.include('&lt;script&gt;').and.include('A &amp; B').and.not.include('<script>');
        expect(text).to.include('<script>x</script>');               // plain text is not HTML
        expect(text).to.include('expires on Sun, 04 Oct 2026 12:00 UTC');
    });

    it('file transport writes a complete .eml message', async () => {
        const dir = join(tmpdir(), `identity-mail-${process.pid}-${Date.now()}`);
        try {
            const mailer = createMailer({ transport: 'file', from: 'Deeds Registry <noreply@example.test>', dir });
            const { service } = await makeService(mailer);
            const res = await service.invite({ name: 'F', email: 'f@deeds.gov.na', roles: ['scan'] }, ADMIN);
            expect(res.email.sent).to.equal(true);
            const [file] = await readdir(dir);
            const eml = await readFile(join(dir, file), 'utf8');
            expect(eml).to.include('To: f@deeds.gov.na').and.include('From: Deeds Registry <noreply@example.test>').and.include('token=');
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('refuses an incomplete configuration at start-up', () => {
        expect(() => createMailer({ transport: 'smtp', from: 'a@b.c' })).to.throw('SMTP_HOST');
        expect(() => createMailer({ transport: 'smtp', host: 'smtp.example.test' })).to.throw('MAIL_FROM');
        expect(() => createMailer({ transport: 'carrier-pigeon', from: 'a@b.c' })).to.throw('smtp, file or none');
        expect(() => createMailer({ transport: 'smtp', from: 'a@b.c', host: 'h', family: 5 })).to.throw('SMTP_FAMILY must be 4 or 6');
        expect(createMailer({ transport: 'smtp', from: 'a@b.c', host: 'smtp.example.test', family: 4 }).describe).to.equal('SMTP smtp.example.test:587 over IPv4');
    });
});
