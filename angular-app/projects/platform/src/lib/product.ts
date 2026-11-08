import {InjectionToken, type Provider} from '@angular/core';

import type {Perm} from './state/rbac.service';
import type {SiteConfig} from './state/site-config';

/** One line of the sign-in page's list of what the product does. */
export interface SignInFact {
  /** The icon's name (icon.component.ts). */
  readonly icon: string;
  /** The word in bold, e.g. "Capture". */
  readonly lead: string;
  /** The rest of the line. */
  readonly text: string;
}

/** The product's presentation on the sign-in page, beside the form. */
export interface SignInPitch {
  readonly eyebrow: string;
  readonly title: string;
  readonly text: string;
  readonly facts: readonly SignInFact[];
  /** The notice at the bottom, e.g. the law under which access is logged. */
  readonly legal: string;
}

/**
 * What a product (an app built on the platform) tells the shared
 * code about itself. Each app provides it once, with provideProduct() in its app.config.ts.
 */
export interface ProductConfig {
  /** Shown after the organisation's name in the browser tab, e.g. "Records portal". */
  readonly title: string;
  /** The organisation's settings used when the site's config.json lacks one (site-config.ts). */
  readonly siteDefaults: SiteConfig;
  /**
   * The permission catalogue, in the groups of the admin screens. The identity service is the
   * source of truth; the app mirrors it to group and label the permissions.
   */
  readonly permGroups: readonly string[];
  readonly perms: readonly Perm[];
  readonly signIn: SignInPitch;
}

/** The product's configuration, for the shared services and screens. */
export const PRODUCT_CONFIG = new InjectionToken<ProductConfig>(
  'PRODUCT_CONFIG',
);

/** Provides the product's configuration to the platform. */
export function provideProduct(config: ProductConfig): Provider {
  return {provide: PRODUCT_CONFIG, useValue: config};
}
