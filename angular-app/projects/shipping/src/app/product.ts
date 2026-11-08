import type {ProductConfig} from '@lrfe/platform';

/**
 * The shipping product (electronic bills of lading, epic CB-1), as the platform sees it. Empty
 * for now: its permissions and texts come with the bill-of-lading tickets.
 */
export const SHIPPING: ProductConfig = {
  title: 'Bills of lading',
  siteDefaults: {
    orgName: 'Shipping Registry',
    orgSubtitle: '',
    orgParent: '',
    orgPlace: '',
  },
  permGroups: [],
  perms: [],
  signIn: {
    eyebrow: 'Electronic bills of lading',
    title: 'Issue, transfer and surrender bills of lading.',
    text: 'Every step can be checked on the blockchain, without trusting the portal.',
    facts: [],
    legal: 'Restricted system. Access is logged.',
  },
};
