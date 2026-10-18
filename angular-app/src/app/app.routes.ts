import {Routes} from '@angular/router';
import {authGuard} from './state/auth.service';
import {permGuard} from './state/rbac.service';
import {LoginComponent} from './features/login/login.component';
import {InviteComponent} from './features/invite/invite.component';
import {DashboardComponent} from './features/dashboard/dashboard.component';
import {FlowComponent} from './features/flow/flow.component';
import {CaptureComponent} from './features/capture/capture.component';
import {VerifyComponent} from './features/verify/verify.component';
import {LinkComponent} from './features/link/link.component';
import {AuditListComponent} from './features/audit/audit-list.component';
import {AuditRecordComponent} from './features/audit/audit-record.component';
import {AuditTrailSearchComponent} from './features/audit/audit-trail-search.component';
import {AnchoringsListComponent} from './features/anchorings/anchorings-list.component';
import {AnchoringBatchComponent} from './features/anchorings/anchoring-batch.component';
import {DocumentsComponent} from './features/documents/documents.component';
import {AdminComponent} from './features/admin/admin.component';
import {AnchoringHealthComponent} from './features/admin/anchoring-health.component';
import {DeniedComponent} from './features/denied/denied.component';
import {CheckProofComponent} from './features/check-proof/check-proof.component';

const g = [authGuard, permGuard];
/** Anyone who works with documents in any stage may browse the EDRMS (same rule as the edrms service). */
const DOC_READERS = [
  'capture.view',
  'verify.view',
  'record.view',
  'audit.view',
];

// One route per line, as a table: the e2e tests read this file line by line to learn every
// screen, its permission and title (e2e/support/catalogue.ts), so the formatter leaves it as is.
// prettier-ignore
export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'invite', component: InviteComponent },
  // public, no sign-in: for anyone given a proof (API-676)
  { path: 'check-a-proof', component: CheckProofComponent, data: { title: 'Check a proof yourself' } },
  { path: '', component: DashboardComponent, canActivate: g, data: { perm: 'dashboard.view', title: 'Dashboard' } },
  { path: 'flow', component: FlowComponent, canActivate: g, data: { perm: 'dashboard.view', title: 'Process & metadata schema', crumb: 'Programme · Phase 1' } },
  { path: 'capture', component: CaptureComponent, canActivate: g, data: { perm: 'capture.view', title: 'Capture', crumb: 'Workspace · Scan station' } },
  { path: 'verify', component: VerifyComponent, canActivate: g, data: { perm: 'verify.view', title: 'Verify metadata', crumb: 'Workspace · Review desk' } },
  { path: 'documents', component: DocumentsComponent, canActivate: g, data: { perm: DOC_READERS, title: 'Documents (EDRMS)', crumb: 'Workspace · Documents of record' } },
  { path: 'link', component: LinkComponent, canActivate: g, data: { perm: 'record.view', title: 'Land record (create/finalize)', crumb: 'Workspace · Records desk' } },
  { path: 'audit', component: AuditListComponent, canActivate: g, data: { perm: 'audit.view', title: 'Audit', crumb: 'Workspace · Read-only' } },
  // reached from the Audit screen's tabs, not the side menu
  { path: 'audit/trail', component: AuditTrailSearchComponent, canActivate: g, data: { perm: 'audit.view', title: 'Audit', crumb: 'Workspace · Read-only', inMenu: false } },
  { path: 'audit/records/:id', component: AuditRecordComponent, canActivate: g, data: { perm: 'audit.view', title: 'Audit', crumb: 'Workspace · Read-only' } },
  { path: 'anchorings', component: AnchoringsListComponent, canActivate: g, data: { perm: 'anchors.view', title: 'Anchorings', crumb: 'Workspace · Read-only' } },
  { path: 'anchorings/:batch', component: AnchoringBatchComponent, canActivate: g, data: { perm: 'anchors.view', title: 'Anchorings', crumb: 'Workspace · Read-only' } },
  { path: 'admin/users', component: AdminComponent, canActivate: g, data: { perm: 'admin.users', tab: 'users', title: 'Users', crumb: 'Administration' } },
  { path: 'admin/offices', component: AdminComponent, canActivate: g, data: { perm: 'admin.offices', tab: 'offices', title: 'Offices', crumb: 'Administration' } },
  { path: 'admin/roles', component: AdminComponent, canActivate: g, data: { perm: 'admin.roles', tab: 'roles', title: 'Roles & permissions', crumb: 'Administration' } },
  { path: 'admin/policies', component: AdminComponent, canActivate: g, data: { perm: 'admin.policies', tab: 'policies', title: 'Security policies', crumb: 'Administration' } },
  { path: 'admin/log', component: AdminComponent, canActivate: g, data: { perm: 'admin.users', tab: 'log', title: 'Access log', crumb: 'Administration' } },
  { path: 'admin/anchoring', component: AnchoringHealthComponent, canActivate: g, data: { perm: 'admin.policies', title: 'Anchoring health', crumb: 'Administration' } },
  { path: 'admin', redirectTo: 'admin/users', pathMatch: 'full' },
  { path: 'denied', component: DeniedComponent, canActivate: [authGuard], data: { title: 'Access denied' } },
  { path: '**', redirectTo: '' }
];
