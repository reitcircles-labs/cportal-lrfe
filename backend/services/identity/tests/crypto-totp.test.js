import { expect } from 'chai';
import { hashPassword, verifyPassword, sha256, safeEqual } from '../src/crypto.js';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, generateSecret, otpauthUrl } from '../src/totp.js';

describe('password hashing', () => {
    it('verifies the right password and rejects others', async () => {
        const stored = await hashPassword('s3cret-passphrase');
        expect(stored).to.match(/^scrypt\$16384\$8\$1\$/);
        expect(await verifyPassword('s3cret-passphrase', stored)).to.equal(true);
        expect(await verifyPassword('wrong', stored)).to.equal(false);
        expect(await verifyPassword('x', null)).to.equal(false);
    });

    it('salts every hash', async () => {
        expect(await hashPassword('same')).to.not.equal(await hashPassword('same'));
    });

    it('sha256 and safeEqual', () => {
        expect(sha256('abc')).to.equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(safeEqual('a', 'a')).to.equal(true);
        expect(safeEqual('a', 'ab')).to.equal(false);
    });
});

describe('TOTP (RFC 6238)', () => {
    // RFC 6238 appendix B test secret, ASCII "12345678901234567890"
    const secret = base32Encode(Buffer.from('12345678901234567890'));

    it('base32 round-trips', () => {
        expect(secret).to.equal('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
        expect(base32Decode(secret).toString()).to.equal('12345678901234567890');
    });

    it('matches the RFC test vectors', () => {
        expect(totp(secret, 59_000, 8)).to.equal('94287082');
        expect(totp(secret, 1111111109_000, 8)).to.equal('07081804');
        expect(totp(secret, 1234567890_000, 8)).to.equal('89005924');
        expect(hotp(secret, 1, 6)).to.equal('287082');
    });

    it('accepts ±1 step of drift, rejects older codes and junk', () => {
        const t = 1_700_000_000_000;
        const code = totp(secret, t);
        expect(verifyTotp(secret, code, t)).to.equal(true);
        expect(verifyTotp(secret, code, t + 30_000)).to.equal(true);
        expect(verifyTotp(secret, code, t + 90_000)).to.equal(false);
        expect(verifyTotp(secret, 'abcdef', t)).to.equal(false);
    });

    it('generates enrolment material', () => {
        const s = generateSecret();
        expect(s).to.match(/^[A-Z2-7]{32}$/);
        expect(otpauthUrl(s, 'a@b.na', 'Deeds Registry')).to.equal(`otpauth://totp/Deeds%20Registry%3Aa%40b.na?secret=${s}&issuer=Deeds%20Registry&algorithm=SHA1&digits=6&period=30`);
    });
});
