import {Injectable, computed, inject, signal} from '@angular/core';
import {PRODUCT_CONFIG} from '../product';
import {
  fullName,
  loadSiteConfig,
  nameAndPlace,
  type SiteConfig,
} from './site-config';

/** The organisation running this portal (site-config.ts), loaded once before the first screen. */
@Injectable({providedIn: 'root'})
export class SiteConfigService {
  private readonly product = inject(PRODUCT_CONFIG);
  private readonly current = signal<SiteConfig>(this.product.siteDefaults);

  readonly config = this.current.asReadonly();
  /** "<name> · <subtitle>" */
  readonly fullName = computed(() => fullName(this.current()));
  /** "<name> · <place>" */
  readonly nameAndPlace = computed(() => nameAndPlace(this.current()));

  async load(): Promise<void> {
    this.current.set(await loadSiteConfig(this.product.siteDefaults));
    document.title = `${this.current().orgName} · ${this.product.title}`;
  }
}
