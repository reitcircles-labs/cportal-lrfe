/**
 * Refusals of the title engine on the shipping app's screens (CB-54, first version). Each page
 * is opened, then someone else acts on the B/L through the API, so that the page is out of date
 * when its user acts: the carrier issues a B/L another clerk issued first, the shipper asks for a
 * change of a B/L it has just endorsed to the buyer, the carrier voids a B/L already void. Each
 * time the page says why in plain words, shows the B/L as it is now, and nothing else changes.
 * Screenshots for the ticket with `npm run evidence -- CB-54 --spec tests-shipping/refusals.spec.ts`
 * (support/evidence.ts).
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import {unique} from '../support/admin';
import {evidence} from '../support/evidence';
import {
  INVITED_PASSWORD,
  committedBl,
  demoEmails,
  dismissToasts,
  negotiableBl,
  TRADE_ROLE,
  organisationWithClerk,
  signIn,
  signInOnScreen,
  type Organisation,
} from '../support/shipping';
import {GATEWAY_URL, SHIPPING_URL} from '../stack/config.mjs';

/** The ticket the screenshots are for. */
const TICKET = 'CB-54';

/** A B/L as the spec knows it. */
interface Bl {
  id: string;
  label: string;
}

/**
 * The refusal the page shows, in its alert.
 * @param page the page
 * @return the alert
 */
function refusalAlert(page: Page): Locator {
  return page.locator('.note.danger[role=alert]');
}

test.describe.configure({mode: 'serial'});
test.use({baseURL: SHIPPING_URL});

test.describe(
  'refusals of the title engine in plain words on the screens (CB-54)',
  {tag: '@CB-54'},
  () => {
    let api: APIRequestContext;
    let admin: {id: string; name: string};
    let carrier: Organisation;
    let shipper: Organisation;
    let buyer: Organisation;

    /**
     * Creates and approves a B/L to order to the shipper, through the API; issues it when asked.
     * @param issue whether to issue it
     * @return the B/L's id and label
     */
    async function approvedBl(issue: boolean): Promise<Bl> {
      return committedBl(api, carrier.clerk, admin, {
        document: negotiableBl(`CB54${unique().toUpperCase()}`.slice(0, 20)),
        partyOrganisations: {shipper: shipper.id},
        issue,
      });
    }

    /**
     * Runs a title command through the API, as another clerk would on another screen.
     * @param id the B/L's id
     * @param name the command
     * @param by the organisation whose clerk runs it
     * @param data the command's arguments
     */
    async function command(
      id: string,
      name: string,
      by: Organisation,
      data: Record<string, unknown>,
    ): Promise<void> {
      const answer = await api.post(`/api/records/${id}/title/${name}`, {
        headers: by.clerk.headers,
        data,
      });
      expect(answer.status(), await answer.text()).toBe(200);
    }

    /**
     * Signs a clerk in on the screen and opens a B/L from the home list.
     * @param page the page
     * @param organisation the clerk's organisation
     * @param bl the B/L
     */
    async function openBl(
      page: Page,
      organisation: Organisation,
      bl: Bl,
    ): Promise<void> {
      await page.setViewportSize({width: 1440, height: 900});
      await signInOnScreen(page, organisation.clerk.email, INVITED_PASSWORD);
      await page.getByRole('link', {name: `Open ${bl.label}`}).click();
      await expect(page.getByRole('heading', {name: bl.label})).toBeVisible();
      await dismissToasts(page);
    }

    test.beforeAll(async ({playwright}) => {
      test.setTimeout(240_000);
      api = await playwright.request.newContext({baseURL: GATEWAY_URL});
      const signedIn = await signIn(api, demoEmails('adm')[0]);
      admin = signedIn;
      carrier = await organisationWithClerk(api, signedIn, 'Carrier');
      shipper = await organisationWithClerk(
        api,
        signedIn,
        'Shipper',
        TRADE_ROLE,
      );
      buyer = await organisationWithClerk(api, signedIn, 'Buyer', TRADE_ROLE);
    });

    test.afterAll(async () => {
      await api.dispose();
    });

    test('the carrier issues a B/L another clerk issued first', async ({
      page,
    }) => {
      const bl = await approvedBl(false);
      await openBl(page, carrier, bl);
      const issue = page.getByRole('button', {name: 'Issue to the shipper'});
      await expect(issue).toBeVisible();
      // another clerk of the carrier issues it meanwhile
      await command(bl.id, 'issue', carrier, {});

      await issue.click();
      await expect(refusalAlert(page)).toHaveText('This B/L is already issued');
      // the page shows the B/L as it is now: issued, once
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText(
        'Issued',
      );
      await expect(issue).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(1);
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Issued by another clerk first: the page says so and shows it issued',
      );
    });

    test('the shipper asks for a change of a B/L it has just endorsed', async ({
      page,
    }) => {
      const bl = await approvedBl(true);
      await openBl(page, shipper, bl);
      const ask = page.getByRole('button', {name: 'Ask for a change'});
      await expect(ask).toBeVisible();
      // another clerk of the shipper endorses it to the buyer meanwhile
      await command(bl.id, 'endorse', shipper, {to: buyer.id, inBlank: false});

      await ask.click();
      const askPanel = page.getByRole('region', {name: 'Ask for a change'});
      await askPanel
        .getByLabel('What needs to change?')
        .fill('Update port of discharge to DEHAM');
      await askPanel.getByRole('button', {name: 'Send to the carrier'}).click();
      await expect(refusalAlert(page)).toContainText(
        'Only the current holder may',
      );
      // nothing changed: the buyer holds it, and the shipper may no longer act on it
      await expect(page.locator('dt:text-is("Your role") + dd')).toHaveText(
        'Past holder',
      );
      await expect(ask).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(2);
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Endorsed meanwhile: the shipper is told only the holder may ask',
      );
    });

    test('the carrier voids a B/L already void', async ({page}) => {
      const bl = await approvedBl(true);
      await openBl(page, carrier, bl);
      const voidButton = page.getByRole('button', {name: 'Void'});
      await expect(voidButton).toBeVisible();
      // another clerk of the carrier voids it meanwhile
      await command(bl.id, 'void', carrier, {});

      await voidButton.click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', {name: 'Void the B/L'})
        .click();
      await expect(refusalAlert(page)).toHaveText(
        'This B/L is void: nothing more can be done with it',
      );
      await expect(page.locator('dt:text-is("State") + dd')).toHaveText('Void');
      await expect(
        page.getByRole('region', {name: 'Actions'}).getByRole('button'),
      ).toHaveCount(0);
      const chain = page.getByRole('table', {name: 'Chain of title'});
      await expect(chain.locator('tbody tr')).toHaveCount(2);
      await dismissToasts(page);
      await evidence(
        page,
        TICKET,
        'Voided meanwhile: the carrier is told nothing more can be done',
      );
    });
  },
);
