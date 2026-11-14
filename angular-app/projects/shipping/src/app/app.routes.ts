import {Routes} from '@angular/router';
import {LoginComponent, authGuard} from '@lrfe/platform';
import {homeGuard, onboardingGuard} from './admin/admin.guards';
import {OrganisationDetailComponent} from './admin/organisation-detail.component';
import {OrganisationListComponent} from './admin/organisation-list.component';
import {BlDetailComponent} from './bls/bl-detail.component';
import {BlListComponent} from './bls/bl-list.component';
import {DeniedComponent} from './denied.component';
import {ShellComponent} from './shell.component';

/**
 * The shipping app's screens: the platform's sign-in, and, signed in, the B/Ls the organisation
 * is party to and the page of each (CB-42); for the platform administrator, the organisations and
 * their staff (CB-43), which anyone else is refused; and that refusal.
 */
export const routes: Routes = [
  {path: 'login', component: LoginComponent},
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      {path: '', component: BlListComponent, canActivate: [homeGuard]},
      {path: 'bls/:id', component: BlDetailComponent},
      {
        path: 'admin/organisations',
        component: OrganisationListComponent,
        canActivate: [onboardingGuard],
      },
      {
        path: 'admin/organisations/:id',
        component: OrganisationDetailComponent,
        canActivate: [onboardingGuard],
      },
      {path: 'denied', component: DeniedComponent},
    ],
  },
  {path: '**', redirectTo: ''},
];
