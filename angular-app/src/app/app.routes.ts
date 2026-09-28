import { Routes } from '@angular/router';
import { FlowComponent } from './features/flow/flow.component';
import { CaptureComponent } from './features/capture/capture.component';
import { VerifyComponent } from './features/verify/verify.component';
import { LinkComponent } from './features/link/link.component';
import { AuditComponent } from './features/audit/audit.component';

export const routes: Routes = [
  { path: '', component: FlowComponent, data: { role: 'Overview', user: '' } },
  { path: 'capture', component: CaptureComponent, data: { role: 'Scan operator', user: 'K. Iipinge' } },
  { path: 'verify', component: VerifyComponent, data: { role: 'Metadata reviewer', user: 'A. Mwandingi' } },
  { path: 'link', component: LinkComponent, data: { role: 'Records officer', user: 'J. !Gawaseb' } },
  { path: 'audit', component: AuditComponent, data: { role: 'Auditor · read-only', user: 'M. Nakale' } },
  { path: '**', redirectTo: '' }
];
