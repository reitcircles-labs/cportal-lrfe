/**
 * The platform library: what every product's web app shares (sign-in, the API client, roles and
 * permissions, site settings, toasts and dialogs, proofs and blockchain checks). Apps import it as
 * `@lrfe/platform`; it never imports an app's code.
 */
export * from './lib/api/anchorings.api';
export * from './lib/api/api.service';
export * from './lib/api/auth.interceptor';
export * from './lib/api/proof.api';
export * from './lib/product';
export * from './lib/shared/anchoring';
export * from './lib/shared/blockchain-verify.component';
export * from './lib/shared/can.directive';
export * from './lib/shared/icon.component';
export * from './lib/shared/info-tip.component';
export * from './lib/shared/overlays.component';
export * from './lib/shared/proof-download.component';
export * from './lib/shared/proof-link.component';
export * from './lib/shared/verify-wording';
export * from './lib/sign-in/login.component';
export * from './lib/state/auth.service';
export * from './lib/state/confirm.service';
export * from './lib/state/rbac.service';
export * from './lib/state/site-config.service';
export * from './lib/state/site-config';
export * from './lib/state/tasks.service';
export * from './lib/state/theme.service';
export * from './lib/state/toast.service';
