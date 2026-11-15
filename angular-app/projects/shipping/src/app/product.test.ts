// The shipping app's sign-in page (CB-48): no coat of arms or logo to hold a place for, so no
// empty dashed box beside the organisation's name.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {hasLogoPlace} from '../../../platform/src/lib/sign-in/logo-place.ts';
import {SHIPPING} from './product.ts';

test('the shipping app has no logo placeholder', () => {
  assert.equal(hasLogoPlace(SHIPPING.signIn), false);
});
