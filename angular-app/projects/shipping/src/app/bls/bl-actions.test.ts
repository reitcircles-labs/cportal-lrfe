// Unit tests for the actions on a B/L's page (CB-44): submitting a draft for approval, the
// second person's approval (four eyes: never the drafter) and the issue (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  approvalNote,
  approvalOf,
  draftersOf,
  issueCommands,
  mayArchive,
  mayCopy,
  mayDraft,
  mayEdit,
  maySubmit,
  versionNote,
} from './bl-actions.ts';
import {NO_CONSIGNEE, draftFacts, draftKind} from './bl-format.ts';
import type {DraftVersion} from './bl.model.ts';

/** The permissions of a clerk who drafts, and of a manager who also issues. */
const CLERK = ['bl.read', 'bl.draft'];
const MANAGER = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/**
 * A version in review, drafted and submitted by Lena.
 * @param over the fields that differ
 * @return the version
 */
function inReview(over: Partial<DraftVersion> = {}): DraftVersion {
  return {
    versionNumber: 1,
    state: 'in_review',
    createdById: 'u-lena',
    submittedById: 'u-lena',
    changes: [
      {byId: 'u-lena', action: 'create'},
      {byId: 'u-lena', action: 'submit'},
    ],
    ...over,
  };
}

describe('who drafted a version', () => {
  it('its creator, whoever changed it and its submitter', () => {
    const drafters = draftersOf(
      inReview({
        submittedById: 'u-jonas',
        changes: [
          {byId: 'u-lena', action: 'create'},
          {byId: 'u-mia', action: 'edit'},
          {byId: 'u-jonas', action: 'submit'},
        ],
      }),
    );
    assert.deepEqual([...drafters].sort(), ['u-jonas', 'u-lena', 'u-mia']);
  });

  it('a reviewer who sent it back before is not a drafter', () => {
    const drafters = draftersOf(
      inReview({
        changes: [
          {byId: 'u-lena', action: 'create'},
          {byId: 'u-ravi', action: 'reject'},
          {byId: 'u-lena', action: 'submit'},
        ],
      }),
    );
    assert.deepEqual([...drafters], ['u-lena']);
  });

  it('a version without a change log: its creator and submitter', () => {
    const drafters = draftersOf(inReview({changes: undefined}));
    assert.deepEqual([...drafters], ['u-lena']);
  });
});

describe('the approval of a draft in review', () => {
  it('a second person who may issue: waiting for their approval', () => {
    const state = approvalOf(inReview(), {id: 'u-ravi', perms: MANAGER});
    assert.equal(state, 'approve');
    assert.equal(approvalNote(state), 'Waiting for your approval');
  });

  it('the drafter, even one who may issue, cannot approve their own draft', () => {
    const state = approvalOf(inReview(), {id: 'u-lena', perms: MANAGER});
    assert.equal(state, 'own-draft');
    assert.match(approvalNote(state), /you prepared this draft/i);
    assert.match(approvalNote(state), /second person/i);
  });

  it('someone who may not issue sees it waiting for approval', () => {
    const state = approvalOf(inReview(), {id: 'u-tom', perms: CLERK});
    assert.equal(state, 'waiting');
    assert.match(approvalNote(state), /waiting for approval/i);
  });

  it('nothing to approve: no draft, or a draft not in review', () => {
    const ravi = {id: 'u-ravi', perms: MANAGER};
    assert.equal(approvalOf(null, ravi), null);
    assert.equal(approvalOf(inReview({state: 'draft'}), ravi), null);
    assert.equal(approvalOf(inReview({state: 'committed'}), ravi), null);
    assert.equal(approvalNote(null), '');
  });
});

describe('submitting a draft and drafting a new B/L', () => {
  it('a draft not yet in review may be submitted by whoever drafts B/Ls', () => {
    assert.equal(maySubmit(inReview({state: 'draft'}), CLERK), true);
    assert.equal(maySubmit(inReview({state: 'draft'}), ['bl.read']), false);
    assert.equal(maySubmit(inReview(), CLERK), false);
    assert.equal(maySubmit(null, CLERK), false);
  });

  it('a new B/L needs bl.draft', () => {
    assert.equal(mayDraft(CLERK), true);
    assert.equal(mayDraft(['bl.read', 'bl.endorse']), false);
    assert.equal(mayDraft([]), false);
  });

  it('editing a draft (CB-70): only its author while not yet approved (draft or in review)', () => {
    const lena = {id: 'u-lena', perms: CLERK};
    const ravi = {id: 'u-ravi', perms: MANAGER};
    assert.equal(mayEdit(inReview({state: 'draft'}), lena), true);
    assert.equal(mayEdit(inReview({state: 'in_review'}), lena), true);
    assert.equal(mayEdit(inReview({state: 'draft'}), ravi), false);
    assert.equal(mayEdit(inReview({state: 'in_review'}), ravi), false);
    assert.equal(mayEdit(inReview({state: 'committed'}), lena), false);
    assert.equal(
      mayEdit(inReview({state: 'draft'}), {id: 'u-lena', perms: ['bl.read']}),
      false,
    );
    assert.equal(mayEdit(null, lena), false);
  });

  it('archiving a draft (CB-71): any carrier user with bl.draft on a never-issued draft (draft or in review)', () => {
    assert.equal(
      mayArchive({status: 'draft', draftState: 'draft', title: null}, CLERK),
      true,
    );
    assert.equal(
      mayArchive(
        {status: 'draft', draftState: 'in_review', title: null},
        CLERK,
      ),
      true,
    );
    assert.equal(
      mayArchive({status: 'committed', draftState: null, title: null}, MANAGER),
      false,
    );
    assert.equal(
      mayArchive({status: 'archived', draftState: null, title: null}, CLERK),
      false,
    );
    assert.equal(
      mayArchive({status: 'draft', draftState: 'draft', title: null}, [
        'bl.read',
      ]),
      false,
    );
    assert.equal(mayArchive(null, CLERK), false);
  });
});

describe('the title commands this page offers', () => {
  it('only the issue, of the commands the user may run', () => {
    assert.deepEqual(issueCommands(['issue', 'void']), ['issue']);
    assert.deepEqual(issueCommands(['endorse', 'surrender']), []);
    assert.deepEqual(issueCommands([]), []);
  });
});

describe('the B/L shown to the approver and at the issue (added: the approval panel shows what is approved; changed: CB-44 review, the linked organisations by name, warnings, its kind)', () => {
  /** The organisations the B/L is linked to, by id, with their names on the platform. */
  const NAMES = {
    'org-exporter': 'Coffee Exporters',
    'org-buyer': 'Buyer Trading',
  };

  /**
   * A document of a B/L, its parties as typed.
   * @param over the fields that differ from a straight B/L
   * @return the document
   */
  function documentOf(
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      transportDocumentTypeCode: 'BOL',
      isToOrder: false,
      documentParties: {
        shipper: {partyName: 'Coffee Exporters'},
        consignee: {partyName: 'Buyer Trading'},
      },
      transports: {
        portOfLoading: {UNLocationCode: 'BRSSZ'},
        portOfDischarge: {UNLocationCode: 'NLRTM'},
        vesselVoyages: [
          {vesselName: 'Atlantic Crest', carrierExportVoyageNumber: '2611N'},
        ],
      },
      utilizedTransportEquipments: [
        {equipment: {equipmentReference: 'MSKU7045123'}},
      ],
      consignmentItems: [{descriptionOfGoods: ['640 bags green coffee']}],
      ...over,
    };
  }

  /** A straight B/L's links: shipper and consignee. */
  const LINKED = {shipper: 'org-exporter', consignee: 'org-buyer'};

  it('its kind, the linked organisations by name, voyage, container, goods and who prepared it', () => {
    const facts = draftFacts(
      inReview({
        createdByName: 'Lena Okafor',
        data: {document: documentOf(), partyOrganisations: LINKED},
      }),
      NAMES,
    );
    assert.deepEqual(facts, [
      {label: 'Kind', value: 'Straight B/L'},
      {label: 'Shipper', value: 'Coffee Exporters'},
      {label: 'Consignee', value: 'Buyer Trading'},
      {label: 'Voyage', value: 'Atlantic Crest 2611N, BRSSZ → NLRTM'},
      {label: 'Container', value: 'MSKU7045123'},
      {label: 'Goods', value: '640 bags green coffee'},
      {label: 'Prepared by', value: 'Lena Okafor'},
    ]);
  });

  it('a B/L to order: negotiable, no consignee, the same words as the B/L box', () => {
    const facts = draftFacts(
      inReview({
        data: {
          document: documentOf({
            isToOrder: true,
            documentParties: {shipper: {partyName: 'Coffee Exporters'}},
          }),
          partyOrganisations: {shipper: 'org-exporter'},
        },
      }),
      NAMES,
    );
    assert.deepEqual(facts.slice(0, 3), [
      {label: 'Kind', value: 'Negotiable B/L'},
      {label: 'Shipper', value: 'Coffee Exporters'},
      {label: 'Consignee', value: NO_CONSIGNEE},
    ]);
    assert.equal(draftKind(documentOf({isToOrder: true})), 'negotiable');
    assert.equal(draftKind(documentOf()), 'straight');
    assert.equal(
      draftKind(documentOf({transportDocumentTypeCode: 'SWB'})),
      'waybill',
    );
  });

  it('a typed name that differs from the linked organisation: the organisation is shown, with a warning', () => {
    const facts = draftFacts(
      inReview({
        data: {
          document: documentOf({
            documentParties: {
              shipper: {partyName: 'Café Serra Alta'},
              consignee: {partyName: 'Buyer Trading'},
            },
          }),
          partyOrganisations: LINKED,
        },
      }),
      NAMES,
    );
    const shipper = facts.find(f => f.label === 'Shipper');
    assert.equal(shipper?.value, 'Coffee Exporters');
    assert.match(shipper?.warning ?? '', /Café Serra Alta/);
    assert.match(shipper?.warning ?? '', /Coffee Exporters/);
    assert.equal(facts.find(f => f.label === 'Consignee')?.warning, undefined);
  });

  it('a party linked to no organisation: its typed name, with a warning', () => {
    const facts = draftFacts(
      inReview({data: {document: documentOf(), partyOrganisations: {}}}),
      NAMES,
    );
    const shipper = facts.find(f => f.label === 'Shipper');
    assert.equal(shipper?.value, 'Coffee Exporters');
    assert.match(shipper?.warning ?? '', /not linked/i);
  });

  it('an organisation whose name is not known: its id, no warning', () => {
    const facts = draftFacts(
      inReview({
        data: {
          document: documentOf(),
          partyOrganisations: {shipper: 'org-x', consignee: 'org-buyer'},
        },
      }),
      NAMES,
    );
    const shipper = facts.find(f => f.label === 'Shipper');
    assert.deepEqual(shipper, {label: 'Shipper', value: 'org-x'});
  });

  it('an approved version also names its approver; what is missing shows a dash', () => {
    const facts = draftFacts(
      inReview({
        state: 'committed',
        approvedByName: 'Ravi Menon',
        data: {document: {isToOrder: true}},
      }),
      {},
    );
    assert.deepEqual(facts.at(-1), {label: 'Approved by', value: 'Ravi Menon'});
    assert.deepEqual(
      facts.find(f => f.label === 'Voyage'),
      {
        label: 'Voyage',
        value: '—',
      },
    );
    assert.equal(facts.find(f => f.label === 'Shipper')?.value, '—');
  });

  it('no version, no facts', () => {
    assert.deepEqual(draftFacts(null, NAMES), []);
  });
});

describe('what the panel says about a version (added: the approved B/L stays visible at the issue)', () => {
  const ravi = {id: 'u-ravi', perms: MANAGER};

  it('in review: the approval note', () => {
    assert.equal(versionNote(inReview(), ravi), 'Waiting for your approval');
  });

  it('approved: by whom, and that it is ready to issue', () => {
    assert.equal(
      versionNote(
        inReview({state: 'committed', approvedByName: 'Ravi Menon'}),
        ravi,
      ),
      'Approved by Ravi Menon: ready to issue.',
    );
  });

  it('a draft not submitted yet', () => {
    assert.equal(
      versionNote(inReview({state: 'draft'}), ravi),
      'Draft: not submitted for approval yet.',
    );
  });
});

describe('copying a B/L (CB-69)', () => {
  it('allows Copy for a carrier user with bl.draft on non-archived B/Ls in any state', () => {
    assert.equal(mayCopy({status: 'draft', roles: ['carrier']}, CLERK), true);
    assert.equal(
      mayCopy({status: 'committed', roles: ['carrier']}, CLERK),
      true,
    );
    assert.equal(
      mayCopy({status: 'committed', roles: ['carrier', 'holder']}, MANAGER),
      true,
    );
  });

  it('hides Copy on archived B/Ls, without bl.draft, or for non-carrier parties', () => {
    assert.equal(mayCopy(null, CLERK), false);
    assert.equal(
      mayCopy({status: 'archived', roles: ['carrier']}, CLERK),
      false,
    );
    assert.equal(
      mayCopy({status: 'committed', roles: ['carrier']}, [
        'bl.read',
        'bl.issue',
      ]),
      false,
    );
    assert.equal(
      mayCopy({status: 'committed', roles: ['holder']}, CLERK),
      false,
    );
    assert.equal(
      mayCopy({status: 'committed', roles: ['consignee']}, CLERK),
      false,
    );
    assert.equal(
      mayCopy({status: 'committed', roles: ['past-holder']}, CLERK),
      false,
    );
  });
});
