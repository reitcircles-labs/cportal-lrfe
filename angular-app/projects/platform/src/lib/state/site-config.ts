/**
 * The organisation that runs this portal, from the site's settings (API-712). Read once at start
 * from `config.json`: in the container its nginx writes the file from the site's `.env`
 * (docker/site-config.sh); with `ng serve` it is `public/config.json`. Display texts only, never a
 * secret: anyone who opens the portal can read the file.
 */
export interface SiteConfig {
  /** e.g. "Titles Office" */
  readonly orgName: string;
  /** shown under the name, e.g. the country; may be empty */
  readonly orgSubtitle: string;
  /** the body it belongs to, on the sign-in page, e.g. a ministry; may be empty */
  readonly orgParent: string;
  /** where it is, e.g. the city; may be empty */
  readonly orgPlace: string;
}

/**
 * Takes each known setting given as a string, trimmed. An empty one stays empty (not shown),
 * except the name, which is never empty. A setting that is missing or not a string gets the
 * product's default (`defaults`, from its ProductConfig).
 */
export function parseSiteConfig(
  raw: unknown,
  defaults: SiteConfig,
): SiteConfig {
  const given =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const read = (key: keyof SiteConfig): string => {
    const value = given[key];
    return typeof value === 'string' ? value.trim() : defaults[key];
  };
  return {
    orgName: read('orgName') || defaults.orgName,
    orgSubtitle: read('orgSubtitle'),
    orgParent: read('orgParent'),
    orgPlace: read('orgPlace'),
  };
}

/**
 * Fetches and reads `config.json`. Never fails: without a usable file the portal still starts,
 * with the defaults.
 */
export async function loadSiteConfig(
  defaults: SiteConfig,
  fetchFn: typeof fetch = fetch,
): Promise<SiteConfig> {
  try {
    const response = await fetchFn('config.json', {cache: 'no-store'});
    if (!response.ok) return defaults;
    return parseSiteConfig(await response.json(), defaults);
  } catch {
    return defaults;
  }
}

/** "<name> · <subtitle>" (or only the name, without a subtitle). */
export function fullName(config: SiteConfig): string {
  return config.orgSubtitle
    ? `${config.orgName} · ${config.orgSubtitle}`
    : config.orgName;
}

/** "<name> · <place>" (or only the name, without a place). */
export function nameAndPlace(config: SiteConfig): string {
  return config.orgPlace
    ? `${config.orgName} · ${config.orgPlace}`
    : config.orgName;
}
