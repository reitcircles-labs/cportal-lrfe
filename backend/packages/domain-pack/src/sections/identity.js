import {fail, isObject} from '../fail.js';

/** The fields an `identity` section may have; each is optional (an empty section is valid). */
const FIELDS = [
  'permissionGroups',
  'permissions',
  'roles',
  'separationOfDuties',
  'offices',
  'demoUsers',
];

/** A permission id, as stored in databases and tokens: `record.view`, `extract.issue`. */
const PERMISSION_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/** A role or rule id: `sup`, `rec`, `sod2`. */
const SHORT_ID = /^[a-z][a-z0-9-]{0,30}$/;
/** An office code, permanent once created: 2 to 5 capital letters. */
const OFFICE_CODE = /^[A-Z]{2,5}$/;
/** The states a demo user can be created in. */
const USER_STATUSES = ['Active', 'Suspended', 'Invited'];

/**
 * Checks the `identity` section of a domain pack: what the product adds to the platform's
 * permissions and roles. Every field is optional:
 *
 * - `permissionGroups`: names of the product's permission groups, in screen order.
 * - `permissions`: `{id, group, label, desc, since?}`; `since` is the catalogue version that
 *   added the permission, so existing databases grant it once to the roles that hold it.
 * - `roles`: `{id, label, desc, home, perms}`; `home` is the screen a user lands on.
 * - `separationOfDuties`: `{id, a, b, label, on}`: holding permissions `a` and `b` conflicts.
 * - `offices`: `{code, name, type, address, contact}` created in an empty database.
 * - `demoUsers`: `{name, email, office, roles, status}` created with a demo password.
 *
 * Whether the ids clash with the platform's, or name permissions and roles that exist, is checked
 * by identity, which knows the platform's own.
 * @param {string} pack the pack's name, for the error
 * @param {object} section the section
 */
export function checkIdentity(pack, section) {
  if (!isObject(section)) {
    fail(pack, '"identity" is not an object');
  }
  const unknown = Object.keys(section).filter(key => !FIELDS.includes(key));
  if (unknown.length) {
    fail(pack, `identity: unknown field(s) ${unknown.join(', ')}`);
  }
  const groups = section.permissionGroups ?? [];
  checkList(pack, 'permissionGroups', groups, (group, where) => {
    checkText(pack, where, group);
  });
  checkUnique(pack, 'permissionGroups', groups);

  const permissions = section.permissions ?? [];
  checkList(pack, 'permissions', permissions, (perm, where) => {
    checkFields(pack, where, perm, ['id', 'group', 'label', 'desc'], ['since']);
    checkId(pack, where, perm.id, PERMISSION_ID);
    if (
      perm.since !== undefined &&
      !(Number.isInteger(perm.since) && perm.since > 0)
    ) {
      fail(pack, `identity: ${where}.since is not a positive whole number`);
    }
  });
  checkUnique(
    pack,
    'permissions',
    permissions.map(p => p.id),
  );

  const roles = section.roles ?? [];
  checkList(pack, 'roles', roles, (role, where) => {
    checkFields(
      pack,
      where,
      role,
      ['id', 'label', 'desc', 'home'],
      [],
      ['perms'],
    );
    checkId(pack, where, role.id, SHORT_ID);
    if (!role.home.startsWith('/')) {
      fail(pack, `identity: ${where}.home is not a path starting with /`);
    }
  });
  checkUnique(
    pack,
    'roles',
    roles.map(r => r.id),
  );

  const rules = section.separationOfDuties ?? [];
  checkList(pack, 'separationOfDuties', rules, (rule, where) => {
    checkFields(pack, where, rule, ['id', 'a', 'b', 'label'], ['on']);
    checkId(pack, where, rule.id, SHORT_ID);
    if (typeof rule.on !== 'boolean') {
      fail(pack, `identity: ${where}.on is not true or false`);
    }
  });
  checkUnique(
    pack,
    'separationOfDuties',
    rules.map(r => r.id),
  );

  const offices = section.offices ?? [];
  checkList(pack, 'offices', offices, (office, where) => {
    checkFields(
      pack,
      where,
      office,
      ['code', 'name', 'type'],
      ['address', 'contact'],
    );
    checkId(pack, where, office.code, OFFICE_CODE, 'code');
    for (const key of ['address', 'contact']) {
      if (typeof office[key] !== 'string') {
        fail(pack, `identity: ${where}.${key} is not a text`);
      }
    }
  });
  checkUnique(
    pack,
    'offices',
    offices.map(o => o.code),
  );

  const users = section.demoUsers ?? [];
  checkList(pack, 'demoUsers', users, (user, where) => {
    checkFields(
      pack,
      where,
      user,
      ['name', 'email'],
      ['office', 'status'],
      ['roles'],
    );
    if (!user.email.includes('@')) {
      fail(pack, `identity: ${where}.email is not an email address`);
    }
    if (typeof user.office !== 'string') {
      fail(pack, `identity: ${where}.office is not a text`);
    }
    if (user.roles.length === 0) {
      fail(pack, `identity: ${where} has no role`);
    }
    if (!USER_STATUSES.includes(user.status)) {
      fail(
        pack,
        `identity: ${where}.status is not one of ${USER_STATUSES.join(', ')}`,
      );
    }
  });
  checkUnique(
    pack,
    'demoUsers',
    users.map(u => u.email),
  );
}

/**
 * Checks that a field is a list, then each of its entries.
 * @param {string} pack
 * @param {string} field the field's name, for the error
 * @param {unknown} list
 * @param {function(?, string)} checkEntry called with each entry and where it is
 */
function checkList(pack, field, list, checkEntry) {
  if (!Array.isArray(list)) {
    fail(pack, `identity: "${field}" is not a list`);
  }
  list.forEach((entry, i) => {
    checkEntry(entry, `${field}[${i}]`);
  });
}

/**
 * Checks that an entry is an object with non-empty texts and lists of texts, and no other field
 * than those and the ones its caller checks, so a misspelt field is caught.
 * @param {string} pack
 * @param {string} where where the entry is, for the error
 * @param {unknown} entry
 * @param {!Array<string>} texts fields that must be non-empty texts
 * @param {!Array<string>=} others other fields the entry may have, checked by the caller
 * @param {!Array<string>=} lists fields that must be lists of non-empty texts
 */
function checkFields(pack, where, entry, texts, others = [], lists = []) {
  if (!isObject(entry)) {
    fail(pack, `identity: ${where} is not an object`);
  }
  for (const key of texts) {
    checkText(pack, `${where}.${key}`, entry[key]);
  }
  for (const key of lists) {
    if (!Array.isArray(entry[key])) {
      fail(pack, `identity: ${where}.${key} is not a list`);
    }
    entry[key].forEach((value, i) => {
      checkText(pack, `${where}.${key}[${i}]`, value);
    });
  }
  const known = [...texts, ...others, ...lists];
  const extra = Object.keys(entry).filter(key => !known.includes(key));
  if (extra.length) {
    fail(pack, `identity: ${where} has unknown field(s) ${extra.join(', ')}`);
  }
}

/**
 * Checks that a value is a non-empty text.
 * @param {string} pack
 * @param {string} where
 * @param {unknown} value
 */
function checkText(pack, where, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(pack, `identity: ${where} is not a text`);
  }
}

/**
 * Checks that an id has its form.
 * @param {string} pack
 * @param {string} where
 * @param {string} id
 * @param {!RegExp} form
 * @param {string=} field the id's field name
 */
function checkId(pack, where, id, form, field = 'id') {
  if (!form.test(id)) {
    fail(pack, `identity: ${where}.${field} "${id}" is not a valid ${field}`);
  }
}

/**
 * Checks that a list has no value twice.
 * @param {string} pack
 * @param {string} field
 * @param {!Array<string>} values
 */
function checkUnique(pack, field, values) {
  const twice = values.find((value, i) => values.indexOf(value) !== i);
  if (twice !== undefined) {
    fail(pack, `identity: ${field} has "${twice}" twice`);
  }
}
