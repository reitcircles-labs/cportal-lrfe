/**
 * The actions on a B/L's page (CB-44): submitting a draft for approval, the approval by a second
 * person of the carrier (four eyes, decided on CB-11: never one of the draft's drafters) and the
 * issue to the shipper. The record service checks each again; these only decide what the page
 * offers. Tested by bl-actions.test.ts (`npm run test:shipping`).
 */
import type {BlState, DraftVersion, PartyRole} from './bl.model';

/** How a user stands towards a draft in review. */
export type ApprovalState = 'approve' | 'own-draft' | 'waiting';

/** Who looks at the draft: their id and permissions. */
export interface Approver {
  id: string;
  perms: readonly string[];
}

/** The permission to draft B/Ls, and the one to approve and issue them. */
const DRAFT_PERMISSION = 'bl.draft';
const ISSUE_PERMISSION = 'bl.issue';

/** The change-log actions of the people who drafted a version. */
const DRAFTING_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'open',
  'edit',
  'submit',
]);

/** The title commands this page offers (CB-44: the issue; the others come with CB-45..46). */
const OFFERED_COMMANDS: readonly string[] = ['issue'];

/** What each approval state tells the user. */
const APPROVAL_NOTES: ReadonlyMap<ApprovalState, string> = new Map([
  ['approve', 'Waiting for your approval'],
  ['own-draft', 'You prepared this draft, so a second person must approve it.'],
  ['waiting', 'Waiting for approval by a person who issues B/Ls.'],
]);

/**
 * The people who drafted a version: who created or opened it, changed it or submitted it. A
 * reviewer who sent it back is not one of them.
 * @param version the version
 * @return their ids
 */
export function draftersOf(version: DraftVersion): Set<string> {
  const drafters = new Set<string>();
  for (const id of [version.createdById, version.submittedById]) {
    if (id) {
      drafters.add(id);
    }
  }
  for (const change of version.changes ?? []) {
    if (DRAFTING_ACTIONS.has(change.action) && change.byId) {
      drafters.add(change.byId);
    }
  }
  return drafters;
}

/**
 * How a user stands towards a draft: they may approve it, it is their own, or it waits for
 * someone else; null when no draft is in review.
 * @param draft the B/L's open draft, null when it has none
 * @param user the user
 * @return the state, or null
 */
export function approvalOf(
  draft: DraftVersion | null,
  user: Approver,
): ApprovalState | null {
  if (draft === null || draft.state !== 'in_review') {
    return null;
  }
  if (draftersOf(draft).has(user.id)) {
    return 'own-draft';
  }
  if (user.perms.includes(ISSUE_PERMISSION)) {
    return 'approve';
  }
  return 'waiting';
}

/**
 * What the page says about the approval.
 * @param state the approval state, null for none
 * @return the text, '' for none
 */
export function approvalNote(state: ApprovalState | null): string {
  if (state === null) {
    return '';
  }
  return APPROVAL_NOTES.get(state) ?? '';
}

/**
 * Whether the user may submit the draft for approval: a draft not yet in review, and the
 * permission to draft.
 * @param draft the open draft, null when there is none
 * @param perms the user's permissions
 * @return true when the page offers it
 */
export function maySubmit(
  draft: DraftVersion | null,
  perms: readonly string[],
): boolean {
  return draft?.state === 'draft' && perms.includes(DRAFT_PERMISSION);
}

/**
 * Whether the user may edit an unapproved draft (CB-70): before submit, while in review, or
 * after it was sent back, by its author only.
 * @param draft the open draft, null when there is none
 * @param user who looks at it: their id and permissions
 * @return true when the page offers Edit
 */
export function mayEdit(draft: DraftVersion | null, user: Approver): boolean {
  if (draft === null || !user.perms.includes(DRAFT_PERMISSION)) {
    return false;
  }
  const editable = draft.state === 'draft' || draft.state === 'in_review';
  return editable && draft.createdById === user.id;
}

/**
 * Whether the user may draft a new B/L.
 * @param perms the user's permissions
 * @return true with the permission to draft
 */
export function mayDraft(perms: readonly string[]): boolean {
  return perms.includes(DRAFT_PERMISSION);
}

/**
 * Whether the user may archive a never-issued draft B/L (CB-71): draft or in review, never
 * committed/issued, with the permission to draft.
 * @param record the B/L's state, null when not loaded
 * @param perms the user's permissions
 * @return true when the page offers Archive
 */
export function mayArchive(
  record: BlState | null,
  perms: readonly string[],
): boolean {
  return record?.status === 'draft' && perms.includes(DRAFT_PERMISSION);
}

/**
 * Whether the user may start a new draft copied from this B/L (CB-69): the permission to
 * draft, on a non-archived B/L of their own organisation (the carrier), in any state.
 * @param target the B/L's status and the viewer's roles on it, null when not loaded
 * @param perms the user's permissions
 * @return true when the page offers Copy
 */
export function mayCopy(
  target: {status: string; roles: readonly PartyRole[]} | null,
  perms: readonly string[],
): boolean {
  if (target === null || target.status === 'archived') {
    return false;
  }
  return perms.includes(DRAFT_PERMISSION) && target.roles.includes('carrier');
}

/**
 * The title commands the page offers, of those the user may run now.
 * @param allowed the title read's allowedCommands
 * @return the ones offered, in that order
 */
export function issueCommands(allowed: readonly string[]): string[] {
  return allowed.filter(name => OFFERED_COMMANDS.includes(name));
}

/** What stands for an approver the version does not name. */
const NONE = '—';

/**
 * What the panel says about a version: the approval note while it is in review, who approved it
 * once committed, and that a draft is not submitted yet.
 * @param version the version
 * @param user who looks at it
 * @return the text
 */
export function versionNote(version: DraftVersion, user: Approver): string {
  if (version.state === 'committed') {
    return `Approved by ${version.approvedByName ?? NONE}: ready to issue.`;
  }
  if (version.state === 'draft') {
    return 'Draft: not submitted for approval yet.';
  }
  return approvalNote(approvalOf(version, user));
}
