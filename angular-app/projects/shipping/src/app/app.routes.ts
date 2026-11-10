import {Routes} from '@angular/router';
import {LoginComponent, authGuard} from '@lrfe/platform';
import {HomeComponent} from './home.component';

/** The shipping app's screens: the platform's sign-in, and an empty home page for now. */
export const routes: Routes = [
  {path: 'login', component: LoginComponent},
  {path: '', component: HomeComponent, canActivate: [authGuard]},
  {path: '**', redirectTo: ''},
];
