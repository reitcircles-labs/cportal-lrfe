/**
 * The land registry's texts for the edrms service (CB-3; before, in edrms' service and record
 * metadata): the business context a filed document's record metadata gets by default (ISO 23081),
 * and the examples in the description of the record metadata fields.
 */
export const edrms = {
  businessFunction: 'Deeds registration',
  /**
   * The business activity of a filed document of a type.
   * @param {string} label the document type's label, e.g. "Deed of transfer"
   * @return {string}
   */
  businessActivity: label => `Registration: ${label.toLowerCase()}`,
  // shown as "(e.g. …)" after the description of these record metadata fields
  metadataExamples: {
    businessFunction: '"Deeds registration"',
    businessActivity: '"Registration of transfer"',
    relationships: 'citesPriorTitle, supports, supersedes',
  },
};
