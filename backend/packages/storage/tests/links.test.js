import { expect } from 'chai';
import { createLinkSigner, storageKey } from '../src/index.js';

describe('@lrfe/storage', () => {
    it('signed links verify until they expire, and only for their subject', () => {
        const links = createLinkSigner('link-secret');
        const now = Date.parse('2026-09-29T10:00:00Z');
        const { exp, sig } = links.sign('doc-1', 300, now);
        expect(links.verify('doc-1', exp, sig, now)).to.equal(true);
        expect(links.verify('doc-2', exp, sig, now)).to.equal(false);
        expect(links.verify('doc-1', exp, sig, now + 301_000)).to.equal(false);
        expect(links.verify('doc-1', exp, 'forged', now)).to.equal(false);
    });

    it('builds safe storage keys', () => {
        expect(storageKey('intake', 'd1', 1, '../../etc/pass wd.pdf')).to.equal('intake/d1/v1/pass_wd.pdf');
    });
});
