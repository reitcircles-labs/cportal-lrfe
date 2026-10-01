import { Routes } from '@angular/router';
import { authGuard } from './state/auth.service';
import { permGuard } from './state/rbac.service';
import { LoginComponent } from './features/login/login.component';
import { InviteComponent } from './features/invite/invite.component';
import { DashboardComponent } from './features/dashboard/dashboard.component';
import { FlowComponent } from './features/flow/flow.component';
import { CaptureComponent } from './features/capture/capture.component';
import { VerifyComponent } from './features/verify/verify.component';
import { LinkComponent } from './features/link/link.component';
import { AuditComponent } from './features/audit/audit.component';
import { DocumentsComponent } from './features/documents/documents.component';
import { AdminComponent } from './features/admin/admin.component';
import { DeniedComponent } from './features/denied/denied.component';

const g = [authGuard, permGuard];
/** Anyone who works with documents in any stage may browse the EDRMS (same rule as the edrms service). */
const DOC_READERS = ['capture.view', 'verify.view', 'record.view', 'audit.view'];

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'invite', component: InviteComponent },
  { path: '', component: DashboardComponent, canActivate: g, data: { perm: 'dashboard.view', title: 'Dashboard', crumb: 'Deeds Registry · Windhoek' } },
  { path: 'flow', component: FlowComponent, canActivate: g, data: { perm: 'dashboard.view', title: 'Process & metadata schema', crumb: 'Programme · Phase 1' } },
  { path: 'capture', component: CaptureComponent, canActivate: g, data: { perm: 'capture.view', title: 'Capture', crumb: 'Workspace · Scan station' } },
  { path: 'verify', component: VerifyComponent, canActivate: g, data: { perm: 'verify.view', title: 'Verify metadata', crumb: 'Workspace · Review desk' } },
  { path: 'documents', component: DocumentsComponent, canActivate: g, data: { perm: DOC_READERS, title: 'Documents (EDRMS)', crumb: 'Workspace · Documents of record' } },
  { path: 'link', component: LinkComponent, canActivate: g, data: { perm: 'record.view', title: 'Land record (create/finalize)', crumb: 'Workspace · Records desk' } },
  { path: 'audit', component: AuditComponent, canActivate: g, data: { perm: 'audit.view', title: 'Audit', crumb: 'Workspace · Read-only' } },
  { path: 'admin/users', component: AdminComponent, canActivate: g, data: { perm: 'admin.users', tab: 'users', title: 'Users', crumb: 'Administration' } },
  { path: 'admin/offices', component: AdminComponent, canActivate: g, data: { perm: 'admin.offices', tab: 'offices', title: 'Offices', crumb: 'Administration' } },
  { path: 'admin/roles', component: AdminComponent, canActivate: g, data: { perm: 'admin.roles', tab: 'roles', title: 'Roles & permissions', crumb: 'Administration' } },
  { path: 'admin/policies', component: AdminComponent, canActivate: g, data: { perm: 'admin.policies', tab: 'policies', title: 'Security policies', crumb: 'Administration' } },
  { path: 'admin/log', component: AdminComponent, canActivate: g, data: { perm: 'admin.users', tab: 'log', title: 'Access log', crumb: 'Administration' } },
  { path: 'admin', redirectTo: 'admin/users', pathMatch: 'full' },
  { path: 'denied', component: DeniedComponent, canActivate: [authGuard], data: { title: 'Access denied', crumb: 'Deeds Registry' } },
  { path: '**', redirectTo: '' }
];
