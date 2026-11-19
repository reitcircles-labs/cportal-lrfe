/**
 * Cross-platform eBL transfer (CB-55, DCSA PINT): the administrator connects a peer eBL platform on
 * `#/admin/organisations`; the shipper endorses & sends a B/L out to a party on that peer platform
 * (with receiver confirmation); the peer returns the B/L to a buyer on this platform, who sees it
 * in `Arrived` state and keeps it (`Keep this B/L`) to continue with normal actions.
 */
import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import {createServer} from 'node:http';
import {expect, test} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  TRADE_ROLE,
  committedBl,
  demoEmails,
  dismissToasts,
  negotiableBl,
  organisationWithClerk,
  signIn,
  signInOnScreen,
} from '../support/shipping';
import {DEMO_PASSWORD, GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** Minimal canonical JSON encoder matching `@lrfe/common` for peer signing. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** Signs a JWS payload with an EC P-256 private key (ES256). */
function signEs256(
  payload: object,
  privateKey: KeyObject,
  kid: string,
): string {
  const header = Buffer.from(
    JSON.stringify({alg: 'ES256', typ: 'lrfe-title-entry', kid}),
  ).toString('base64url');
  const body = Buffer.from(canonical(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = cryptoSign('sha256', Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${data}.${sig}`;
}

test.describe('Cross-platform eBL transfer (CB-55)', () => {
  test.use({baseURL: SHIPPING_URL});

  test(
    'connects a peer platform, sends a B/L out, receives it back, and keeps it',
    {tag: '@CB-55'},
    async ({page, playwright}) => {
      test.setTimeout(240_000);
      const {publicKey, privateKey} = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
      });
      const jwk = publicKey.export({format: 'jwk'}) as Record<string, unknown>;
      const kid = 'meridian-k1';
      const jwks = {keys: [{...jwk, kid, alg: 'ES256', use: 'sig'}]};
      const receivedEnvelopes: Array<Record<string, unknown>> = [];

      const peerServer = createServer((req, res) => {
        if (
          req.method === 'GET' &&
          req.url?.startsWith('/records/pint/parties')
        ) {
          const parsed = new URL(req.url, 'http://127.0.0.1');
          const partyCode = parsed.searchParams.get('partyCode');
          if (partyCode === 'MERIDIAN-BANK') {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(
              JSON.stringify({
                partyCode,
                partyName: 'Meridian Trade Bank Ltd',
              }),
            );
            return;
          }
          res.writeHead(404, {'content-type': 'application/json'});
          res.end(JSON.stringify({message: 'Party not found'}));
          return;
        }
        if (req.method === 'POST' && req.url === '/records/pint/transfers') {
          const chunks: Buffer[] = [];
          req.on('data', chunk => chunks.push(Buffer.from(chunk)));
          req.on('end', () => {
            const envelope = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as Record<string, unknown>;
            receivedEnvelopes.push(envelope);
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(
              JSON.stringify({
                responseCode: 'RECE',
                envelopeId: envelope['envelopeId'],
                recordId: 'peer-rec-1',
              }),
            );
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>(resolve =>
        peerServer.listen(0, '127.0.0.1', resolve),
      );
      const addr = peerServer.address();
      const peerPort = typeof addr === 'object' && addr ? addr.port : 0;
      const peerBaseUrl = `http://127.0.0.1:${peerPort}`;

      const api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      try {
        const admin = await signIn(api, demoEmails('adm')[0]);
        const carrier = await organisationWithClerk(api, admin, 'Carrier');
        const shipper = await organisationWithClerk(
          api,
          admin,
          'Shipper',
          TRADE_ROLE,
        );
        const buyer = await organisationWithClerk(
          api,
          admin,
          'Buyer',
          TRADE_ROLE,
        );

        const bl = await committedBl(api, carrier.clerk, admin, {
          document: negotiableBl(`CB55${unique().toUpperCase()}`.slice(0, 16)),
          partyOrganisations: {shipper: shipper.id},
          issue: true,
        });

        // 1. Admin connects Meridian eBL on #/admin/organisations
        const platformCode = `MRD${unique().toUpperCase()}`.slice(0, 12);
        await page.setViewportSize({width: 1440, height: 1000});
        await signInOnScreen(page, demoEmails('adm')[0], DEMO_PASSWORD);
        await page.goto('/#/admin/organisations');
        const platformPanel = page.getByRole('region', {
          name: 'Connected platforms',
        });
        await platformPanel.getByLabel('Platform name').fill('Meridian eBL');
        await platformPanel.getByLabel('Platform ID').fill(platformCode);
        await platformPanel.getByLabel('Base URL').fill(peerBaseUrl);
        await platformPanel
          .getByLabel('Public keys (JWKS JSON)')
          .fill(JSON.stringify(jwks));
        await platformPanel
          .getByRole('button', {name: 'Connect platform'})
          .click();
        await expect(
          platformPanel.getByRole('table', {name: 'Connected platforms'}),
        ).toContainText(platformCode);
        await dismissToasts(page);
        await platformPanel.scrollIntoViewIfNeeded();
        await evidence(
          page,
          'CB-55',
          'Connected eBL platform registered in admin',
        );

        // 2. Shipper endorses & sends the B/L to Meridian eBL
        await page.getByRole('button', {name: 'Sign out'}).click();
        await signInOnScreen(page, shipper.clerk.email, INVITED_PASSWORD);
        await page
          .getByRole('link', {name: `Open ${bl.label}`, exact: true})
          .click();
        await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
        await page.getByRole('button', {name: 'Endorse to…'}).click();

        const endorsePanel = page.getByRole('region', {name: 'Endorse'});
        await endorsePanel.getByLabel('A party on another platform').check();
        await endorsePanel
          .getByLabel('Platform', {exact: true})
          .selectOption(platformCode);
        await endorsePanel
          .getByLabel('Party code at that platform')
          .fill('MERIDIAN-BANK');
        await endorsePanel
          .getByRole('button', {name: 'Check receiver'})
          .click();
        await expect(endorsePanel.getByRole('status')).toContainText(
          'Meridian Trade Bank Ltd',
        );
        await dismissToasts(page);
        await evidence(
          page,
          'CB-55',
          'Endorse to a party on another eBL platform',
        );

        await endorsePanel
          .getByRole('button', {name: 'Send to platform'})
          .click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', {name: 'Send to platform', exact: true})
          .click();

        await expect(page.getByText('Transferred out').first()).toBeVisible();
        await expect(page.getByText(/copy is no longer valid/)).toBeVisible();
        await dismissToasts(page);
        await evidence(page, 'CB-55', 'B/L transferred out to peer platform');

        expect(receivedEnvelopes).toHaveLength(1);
        const sent = receivedEnvelopes[0];
        const chain = sent['chain'] as Array<Record<string, unknown>>;

        // 3. Peer endorses the B/L back to Buyer on this platform via POST /api/records/pint/transfers
        const lastEntry = chain.at(-1);
        if (!lastEntry) {
          throw new Error('Missing final chain entry in envelope');
        }
        const nextSeq = chain.length + 1;
        const receiveContent = {
          recordId: lastEntry['recordId'],
          seq: nextSeq,
          command: 'receive-in',
          actor: {
            id: platformCode,
            name: 'Meridian eBL',
            org: 'MERIDIAN-BANK',
          },
          from: sent['senderPlatform'],
          to: 'MERIDIAN-BANK',
          endorsement: 'named',
          documentHash: sent['documentHash'],
          at: new Date().toISOString(),
          previousHash: lastEntry['entryHash'],
          kid,
        };
        const receiveEntryHash = createHash('sha256')
          .update(canonical(receiveContent))
          .digest('hex');
        const receiveEntry = {
          ...receiveContent,
          entryHash: receiveEntryHash,
          signature: signEs256(receiveContent, privateKey, kid),
        };

        const outContent = {
          recordId: lastEntry['recordId'],
          seq: nextSeq + 1,
          command: 'transfer-out',
          actor: {id: 'u-mrd', name: 'Grace Mensah', org: 'MERIDIAN-BANK'},
          from: 'MERIDIAN-BANK',
          to: buyer.id,
          endorsement: 'named',
          documentHash: sent['documentHash'],
          at: new Date(Date.now() + 1000).toISOString(),
          previousHash: receiveEntryHash,
          kid,
        };
        const outEntryHash = createHash('sha256')
          .update(canonical(outContent))
          .digest('hex');
        const outEntry = {
          ...outContent,
          entryHash: outEntryHash,
          signature: signEs256(outContent, privateKey, kid),
        };

        const returnRes = await api.post('/api/records/pint/transfers', {
          data: {
            envelopeId: `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`,
            senderPlatform: platformCode,
            receiverPartyCode: buyer.id,
            inBlank: false,
            schemaVersion: sent['schemaVersion'],
            document: sent['document'],
            partyOrganisations: sent['partyOrganisations'],
            documentHash: sent['documentHash'],
            chain: [...chain, receiveEntry, outEntry],
          },
        });
        expect(returnRes.status(), await returnRes.text()).toBe(200);
        expect((await returnRes.json()).responseCode).toBe('RECE');

        // 4. Buyer signs in, sees the B/L in Arrived state, and keeps it ("Keep this B/L")
        await page.getByRole('button', {name: 'Sign out'}).click();
        await signInOnScreen(page, buyer.clerk.email, INVITED_PASSWORD);
        await page
          .getByRole('link', {name: `Open ${bl.label}`, exact: true})
          .click();
        await expect(
          page.getByText('Arrived', {exact: true}).first(),
        ).toBeVisible();
        await page.getByRole('button', {name: 'Keep this B/L'}).click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', {name: 'Keep this B/L', exact: true})
          .click();

        await expect(
          page.getByText('With holder', {exact: true}).first(),
        ).toBeVisible();
        await expect(
          page.getByRole('button', {
            name: 'Surrender to the carrier',
            exact: true,
          }),
        ).toBeVisible();
        await dismissToasts(page);
        await evidence(page, 'CB-55', 'Arrived B/L kept by receiving holder');
      } finally {
        await api.dispose();
        await new Promise<void>(resolve => peerServer.close(() => resolve()));
      }
    },
  );
});
