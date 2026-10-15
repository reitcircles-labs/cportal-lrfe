import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_SITE_CONFIG, fullName, loadSiteConfig, nameAndPlace, type SiteConfig } from './site-config';

/** The organisation running this portal (site-config.ts), loaded once before the first screen. */
@Injectable({ providedIn: 'root' })
export class SiteConfigService {
  private readonly current = signal<SiteConfig>(DEFAULT_SITE_CONFIG);

  readonly config = this.current.asReadonly();
  /** "Deeds Registry · Republic of Namibia" */
  readonly fullName = computed(() => fullName(this.current()));
  /** "Deeds Registry · Windhoek" */
  readonly nameAndPlace = computed(() => nameAndPlace(this.current()));

  async load(): Promise<void> {
    this.current.set(await loadSiteConfig());
    document.title = `${this.current().orgName} · Land records intake`;
  }
}
