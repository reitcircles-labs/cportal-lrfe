import {expect} from 'chai';
import {createBaseApp, OFFSET_SCHEMA} from '../src/index.js';

describe('OFFSET_SCHEMA (API-820)', () => {
  const app = createBaseApp({name: 'test'});
  app.get(
    '/list',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {offset: OFFSET_SCHEMA},
        },
      },
    },
    async req => ({offset: req.query.offset}),
  );
  const offset = async value =>
    app.inject({url: `/list${value === undefined ? '' : `?offset=${value}`}`});

  it('defaults to 0 and takes any offset an integer column can hold', async () => {
    expect((await offset()).json()).to.deep.equal({offset: 0});
    expect((await offset(2147483647)).json()).to.deep.equal({
      offset: 2147483647,
    });
  });

  it('refuses a negative offset or one beyond what the database holds: 400', async () => {
    expect((await offset(-1)).statusCode).to.equal(400);
    expect((await offset(2147483648)).statusCode).to.equal(400);
    expect((await offset('9223372036854775808')).statusCode).to.equal(400);
  });
});
