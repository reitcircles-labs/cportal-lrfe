import type {ProductConfig} from '@lrfe/platform';

/**
 * The shipping product (electronic bills of lading, epic CB-1), as the platform sees it. Its
 * permissions come with the bill-of-lading tickets.
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
    logoPlaceholder: ['Logo'],
    eyebrow: 'Electronic bills of lading',
    title: 'Issue, transfer and surrender bills of lading.',
    text: 'Every step can be checked on the blockchain, without trusting the portal.',
    facts: [
      {icon: 'file', lead: 'Issue', text: 'a bill of lading or a sea waybill'},
      {icon: 'link', lead: 'Transfer', text: 'it to the next holder'},
      {icon: 'inbox', lead: 'Surrender', text: 'it to take delivery'},
      {icon: 'shield', lead: 'Check', text: 'any step on the blockchain'},
    ],
    legal: 'Restricted system. Access is logged.',
    // the agreed design of CB-6: a port, drawn for the product
    picture: {
      wide: 'sign-in/port-wide.svg',
      wideSize: [640, 300],
      narrow: 'sign-in/port-narrow.svg',
      narrowSize: [390, 130],
    },
  },
};
