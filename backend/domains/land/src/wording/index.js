import {audit} from './audit.js';
import {edrms} from './edrms.js';
import {extracts} from './extracts.js';
import {identity} from './identity.js';

/** The land registry's texts, one part per service. */
export const wording = {edrms, identity, audit, extracts};
