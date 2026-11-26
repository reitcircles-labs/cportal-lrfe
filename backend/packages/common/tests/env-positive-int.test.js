import {expect} from 'chai';
import {envPositiveInt} from '../src/index.js';

/** CB-101: limits read from the environment must be whole numbers above zero. */
describe('envPositiveInt', () => {
  afterEach(() => {
    delete process.env.TEST_LIMIT;
  });

  it('returns the fallback when the setting is unset or empty', () => {
    expect(envPositiveInt('TEST_LIMIT', 60)).to.equal(60);
    process.env.TEST_LIMIT = '';
    expect(envPositiveInt('TEST_LIMIT', 60)).to.equal(60);
  });

  it('returns a whole number above zero, spaces around it ignored', () => {
    process.env.TEST_LIMIT = '1';
    expect(envPositiveInt('TEST_LIMIT', 60)).to.equal(1);
    process.env.TEST_LIMIT = ' 600 ';
    expect(envPositiveInt('TEST_LIMIT', 60)).to.equal(600);
  });

  for (const value of ['0', '-1', 'abc', '12abc', '1.5', '1e3', '+3']) {
    it(`refuses "${value}", naming the setting`, () => {
      process.env.TEST_LIMIT = value;
      expect(() => envPositiveInt('TEST_LIMIT', 60)).to.throw(
        Error,
        /TEST_LIMIT must be a whole number above 0/,
      );
    });
  }
});
