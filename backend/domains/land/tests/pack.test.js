import {checkDomainPack} from '@lrfe/domain-pack';
import {expect} from 'chai';

import {pack} from '../src/index.js';

describe('the land domain pack (CB-3)', () => {
  it('passes the pack check', () => {
    expect(checkDomainPack(pack, 'land').name).to.equal('land');
  });
});
