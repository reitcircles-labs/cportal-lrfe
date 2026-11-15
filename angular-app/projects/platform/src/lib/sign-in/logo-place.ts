import type {SignInPitch} from '../product';

/**
 * Whether the sign-in page shows the logo place (CB-48): only when the product gives lines to
 * show there until the site has a logo ("Coat of arms" for the land registry). A product without
 * them shows no empty dashed box.
 * @param pitch the product's sign-in pitch
 * @return whether to show the logo place
 */
export function hasLogoPlace(
  pitch: Pick<SignInPitch, 'logoPlaceholder'>,
): boolean {
  return pitch.logoPlaceholder.length > 0;
}
