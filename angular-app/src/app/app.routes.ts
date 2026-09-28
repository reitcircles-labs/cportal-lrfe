import { Routes } from '@angular/router';
import { authGuard } from './state/auth.service';
import { LoginComponent } from './features/login/login.component';
import { DashboardComponent } from './features/dashboard/dashboard.component';
import { FlowComponent } from './features/flow/flow.component';
import { CaptureComponent } from './features/capture/capture.component';
import { VerifyComponent } from './features/verify/verify.component';
import { LinkComponent } from './features/link/link.component';
import { AuditComponent } from './features/audit/audit.component';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: DashboardComponent, canActivate: [authGuard], data: { title: 'Dashboard', crumb: 'Deeds Registry · Windhoek' } },
  { path: 'flow', component: FlowComponent, canActivate: [authGuard], data: { title: 'Process & metadata schema', crumb: 'Programme · Phase 1' } },
  { path: 'capture', component: CaptureComponent, canActivate: [authGuard], data: { title: 'Capture · batch WDH-B017', crumb: 'Workspace · Scan station' } },
  { path: 'verify', component: VerifyComponent, canActivate: [authGuard], data: { title: 'Verify metadata', crumb: 'Workspace · Review desk' } },
  { path: 'link', component: LinkComponent, canActivate: [authGuard], data: { title: 'Land record (create/finalize)', crumb: 'Workspace · Records desk' } },
  { path: 'audit', component: AuditComponent, canActivate: [authGuard], data: { title: 'Audit', crumb: 'Workspace · Read-only' } },
  { path: '**', redirectTo: '' }
];
