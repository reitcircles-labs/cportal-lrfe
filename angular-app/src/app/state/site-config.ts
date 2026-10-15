/**
 * The organisation that runs this portal, from the site's settings (API-712). Read once at start
 * from `config.json`: in the container its nginx writes the file from the site's `.env`
 * (docker/site-config.sh); with `ng serve` it is `public/config.json`. Display texts only, never a
 * secret: anyone who opens the portal can read the file.
 */
export interface SiteConfig {
  /** e.g. "Deeds Registry" */
  readonly orgName: string;
  /** shown under the name, e.g. "Republic of Namibia"; may be empty */
  readonly orgSubtitle: string;
  /** the body it belongs to, on the sign-in page, e.g. a ministry; may be empty */
  readonly orgParent: string;
  /** where it is, e.g. "Windhoek"; may be empty */
  readonly orgPlace: string;
}

/** Used for a setting the file does not have at all, and when the file is missing or broken. */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  orgName: 'Deeds Registry',
  orgSubtitle: 'Republic of Namibia',
  orgParent: 'Ministry of Agriculture, Fisheries, Water and Land Reform',
  orgPlace: 'Windhoek',
};

/**
 * Takes each known setting given as a string, trimmed. An empty one stays empty (not shown),
 * except the name, which is never empty. A setting that is missing or not a string gets the
 * default.
 */
export function parseSiteConfig(raw: unknown): SiteConfig {
  const given = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const read = (key: keyof SiteConfig): string => {
    const value = given[key];
    return typeof value === 'string' ? value.trim() : DEFAULT_SITE_CONFIG[key];
  };
  return {
    orgName: read('orgName') || DEFAULT_SITE_CONFIG.orgName,
    orgSubtitle: read('orgSubtitle'),
    orgParent: read('orgParent'),
    orgPlace: read('orgPlace'),
  };
}

/**
 * Fetches and reads `config.json`. Never fails: without a usable file the portal still starts,
 * with the defaults.
 */
export async function loadSiteConfig(fetchFn: typeof fetch = fetch): Promise<SiteConfig> {
  try {
    const response = await fetchFn('config.json', { cache: 'no-store' });
    if (!response.ok) return DEFAULT_SITE_CONFIG;
    return parseSiteConfig(await response.json());
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}

/** "Deeds Registry · Republic of Namibia" (or only the name, without a subtitle). */
export function fullName(config: SiteConfig): string {
  return config.orgSubtitle ? `${config.orgName} · ${config.orgSubtitle}` : config.orgName;
}

/** "Deeds Registry · Windhoek" (or only the name, without a place). */
export function nameAndPlace(config: SiteConfig): string {
  return config.orgPlace ? `${config.orgName} · ${config.orgPlace}` : config.orgName;
}
