import type {ProductConfig} from '@lrfe/platform';

import {PERM_GROUPS, PERMS} from './state/perm-catalogue';

/** The land registry, as the platform sees it (provided in app.config.ts). */
export const LAND_REGISTRY: ProductConfig = {
  title: 'Land records intake',
  // Namibian values, only as the defaults of a site that sets none (API-712)
  siteDefaults: {
    orgName: 'Deeds Registry',
    orgSubtitle: 'Republic of Namibia',
    orgParent: 'Ministry of Agriculture, Fisheries, Water and Land Reform',
    orgPlace: 'Windhoek',
  },
  permGroups: PERM_GROUPS,
  perms: PERMS,
  signIn: {
    logoPlaceholder: ['Coat of', 'arms'],
    eyebrow: 'National land records programme',
    title: 'Every erf, every owner, one verified record.',
    text: 'Scan and verify historical deeds, link them into land records, and prepare each record for tokenization, with a complete audit trail at every step.',
    facts: [
      {icon: 'scan', lead: 'Capture', text: 'deeds, grants and SG diagrams'},
      {
        icon: 'inbox',
        lead: 'Verify',
        text: 'extracted metadata against the image',
      },
      {
        icon: 'link',
        lead: 'Link',
        text: "documents into the erf's chain of title",
      },
      {icon: 'shield', lead: 'Audit', text: 'every action, hash-chained'},
    ],
    legal:
      'Restricted system. Access is logged under the Deeds Registries Act 14 of 2015.',
  },
};
