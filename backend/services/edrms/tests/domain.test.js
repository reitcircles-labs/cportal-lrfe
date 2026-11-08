import {expect} from 'chai';
import {loadDomainPack} from '@lrfe/common';
import {deedMeta, makeApp, pdfFile} from './helpers.js';

describe('edrms with another domain pack (CB-3)', () => {
  it('starts with the empty shipping pack: no document types, the generic metadata', async () => {
    const pack = await loadDomainPack('shipping');
    const {app, bearer, userToken, service} = await makeApp({pack});
    const res = await app.inject({
      url: '/catalogue',
      headers: bearer(userToken([])),
    });
    expect(res.statusCode).to.equal(200);
    expect(res.json().docTypes).to.deep.equal([]);
    const fields = res.json().recordMetadataFields;
    expect(fields.businessFunction.description).to.equal(
      'Business function that created the record.',
    );
    expect(service.config.defaultRecordMetadata).not.to.have.property(
      'businessFunction',
    );
    const list = await app.inject({
      url: '/documents',
      headers: bearer(userToken(['record.view'])),
    });
    expect(list.statusCode).to.equal(200);
    expect(list.json().items).to.deep.equal([]);
    const typed = await app.inject({
      url: '/documents?docType=deed_of_transfer',
      headers: bearer(userToken(['record.view'])),
    });
    expect(typed.statusCode).to.equal(400);
    try {
      await service.fileDocument({meta: deedMeta(), file: pdfFile()});
      expect.fail('a land document type was filed');
    } catch (err) {
      expect(err.statusCode).to.equal(400);
      expect(err.message).to.equal(
        'This install has no document types to file',
      );
    }
  });

  it('takes the land texts from the land pack', async () => {
    const {app, bearer, userToken} = await makeApp();
    const res = await app.inject({
      url: '/catalogue',
      headers: bearer(userToken([])),
    });
    expect(res.json().docTypes[0]).to.deep.equal({
      id: 'deed_of_transfer',
      label: 'Deed of transfer',
      refField: 'deedNo',
    });
    expect(
      res.json().recordMetadataFields.businessFunction.description,
    ).to.equal(
      'Business function that created the record (e.g. "Deeds registration").',
    );
  });
});
