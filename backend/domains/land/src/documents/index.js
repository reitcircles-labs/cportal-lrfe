import {demo} from './demo.js';
import {fieldTypes} from './field-types.js';
import {reading} from './reading.js';
import {formatReference} from './reference.js';
import {types} from './types.js';

/**
 * The land registry's `documents` section (CB-3): the document types and their fields, the form
 * of an instrument reference, the field checks, how intake reads the instruments, the field that
 * names whom a document is for, and the demo readings. Used by edrms, intake and search.
 */
export const documents = {
  types,
  formatReference,
  fieldTypes,
  reading,
  // whom a document is for, first found first: the (first) transferee of a deed, the owner who
  // grants a bond (the search's party column)
  partyFields: ['tee1', 'mortgagor'],
  demo,
};
