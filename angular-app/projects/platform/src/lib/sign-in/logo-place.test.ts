// The logo place on the sign-in page (CB-48): shown with the product's placeholder lines until the
// site has a logo; a product without placeholder lines shows no empty dashed box. The land
// registry keeps its "Coat of arms" placeholder; the shipping app has none
// (projects/shipping/src/app/product.test.ts).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {hasLogoPlace} from './logo-place.ts';

test('a product with placeholder lines shows the logo place', () => {
  assert.equal(hasLogoPlace({logoPlaceholder: ['Coat of', 'arms']}), true);
});

test('a product without placeholder lines shows no logo place', () => {
  assert.equal(hasLogoPlace({logoPlaceholder: []}), false);
});

test('the land registry keeps its placeholder, unchanged', () => {
  // read as text: the land product's module imports files node cannot load on its own
  const land = readFileSync(
    new URL('../../../../land-registry/src/app/product.ts', import.meta.url),
    'utf8',
  );
  assert.match(land, /logoPlaceholder: \['Coat of', 'arms'\]/);
});
