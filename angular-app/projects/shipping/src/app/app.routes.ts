import {Routes} from '@angular/router';
import {LoginComponent, authGuard} from '@lrfe/platform';
import {BlDetailComponent} from './bls/bl-detail.component';
import {BlListComponent} from './bls/bl-list.component';
import {ShellComponent} from './shell.component';

/**
 * The shipping app's screens: the platform's sign-in, and, signed in, the B/Ls the organisation
 * is party to and the page of each (CB-42).
 */
export const routes: Routes = [
  {path: 'login', component: LoginComponent},
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      {path: '', component: BlListComponent},
      {path: 'bls/:id', component: BlDetailComponent},
    ],
  },
  {path: '**', redirectTo: ''},
];
