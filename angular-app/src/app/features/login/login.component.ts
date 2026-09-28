import { Component, inject, signal } from '@angular/core';
import { AuthService, ROLES } from '../../state/auth.service';
import { ThemeService } from '../../state/theme.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="wrap">
      <section class="hero">
        <div class="flag" aria-hidden="true"></div>
        <div class="hero-in">
          <div class="brand">
            <span class="arms">Coat of<br>arms</span>
            <span class="stack" style="gap:0"><b>Deeds Registry</b><span>Ministry of Agriculture, Fisheries, Water and Land Reform</span></span>
          </div>
          <div class="pitch">
            <span class="eyebrow">National land records programme</span>
            <h1>Every erf, every owner, one verified record.</h1>
            <p>Scan and verify historical deeds, link them into land records, and prepare each record for tokenization, with a complete audit trail at every step.</p>
          </div>
          <ul class="facts">
            <li><app-icon name="scan" [size]="18" /><span><b>Capture</b> deeds, grants and SG diagrams</span></li>
            <li><app-icon name="inbox" [size]="18" /><span><b>Verify</b> extracted metadata against the image</span></li>
            <li><app-icon name="link" [size]="18" /><span><b>Link</b> documents into the erf's chain of title</span></li>
            <li><app-icon name="shield" [size]="18" /><span><b>Audit</b> every action, hash-chained</span></li>
          </ul>
          <span class="legal">Restricted system. Access is logged under the Deeds Registries Act 14 of 2015.</span>
        </div>
      </section>

      <section class="formside">
        <button class="btn btn-ghost btn-icon theme" (click)="theme.toggle()" aria-label="Toggle dark mode"><app-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="19" /></button>
        <form class="card" (submit)="$event.preventDefault(); auth.login(role())">
          <div class="stack" style="gap:4px">
            <h2 style="margin:0">Sign in</h2>
            <span class="muted" style="font-size:14px">Use your registry credentials or national eID.</span>
          </div>
          <div class="field"><label for="uid">Official ID or email</label><input id="uid" class="input" value="a.mwandingi@deeds.gov.na" autocomplete="username"></div>
          <div class="field"><label for="pw">Password</label><input id="pw" class="input" type="password" value="demo-password" autocomplete="current-password"></div>
          <div class="field">
            <label for="role">Sign in as</label>
            <select id="role" class="input" [value]="role()" (change)="role.set($any($event.target).value)">
              @for (r of roles; track r.id) { <option [value]="r.id">{{ r.label }} · {{ r.name }}</option> }
            </select>
          </div>
          <div class="row" style="justify-content:space-between">
            <label class="row" style="gap:8px;font-size:13.5px;cursor:pointer"><input type="checkbox" checked style="accent-color:var(--color-accent);width:16px;height:16px"> Keep me signed in on this device</label>
            <a href="" (click)="$event.preventDefault()" style="font-size:13.5px">Forgot password?</a>
          </div>
          <button class="btn btn-primary" type="submit" style="min-height:44px;font-size:15px"><app-icon name="lock" [size]="17" />Sign in</button>
          <div class="or"><span>or</span></div>
          <button class="btn btn-secondary" type="button" style="min-height:44px" (click)="auth.login(role())"><app-icon name="idcard" [size]="18" />Continue with national eID</button>
          <p class="small muted" style="margin:0;text-align:center">Demo build · any credentials work</p>
        </form>
      </section>
    </div>
  `,
  styles: [`
    .wrap { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
    .hero { position: relative; background: radial-gradient(120% 90% at 0% 0%, #123a6b 0%, var(--sidebar-bg) 55%, #081a33 100%); color: #dbe5f2; display: flex; flex-direction: column; overflow: hidden; }
    .hero::after { content: ""; position: absolute; right: -120px; bottom: -120px; width: 420px; height: 420px; border-radius: 50%; border: 1px solid rgba(255,206,0,.18); box-shadow: 0 0 0 40px rgba(255,206,0,.04), 0 0 0 80px rgba(255,206,0,.03); pointer-events: none; }
    .flag { height: 8px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .hero-in { flex: 1; display: flex; flex-direction: column; gap: 40px; padding: 44px 56px; max-width: 640px; position: relative; z-index: 1; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand b { color: #fff; font-size: 18px; }
    .brand span span { font-size: 13px; color: #aebfd6; }
    .arms { width: 56px; height: 56px; flex: none; border-radius: 12px; border: 1px dashed rgba(255,255,255,.4); display: grid; place-items: center; text-align: center; font-size: 10px; line-height: 1.1; background: rgba(255,206,0,.08); }
    .pitch { margin-top: auto; }
    .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--nam-gold); }
    .pitch h1 { color: #fff; font-size: 42px; line-height: 1.1; letter-spacing: -.02em; margin: 12px 0 14px; text-wrap: balance; }
    .pitch p { font-size: 16px; color: #c3d1e4; max-width: 50ch; margin: 0; }
    .facts { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
    .facts li { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: #c3d1e4; }
    .facts app-icon { color: var(--nam-gold); margin-top: 1px; }
    .facts b { color: #fff; }
    .legal { font-size: 12px; color: #8ea3c0; }
    .formside { position: relative; display: grid; place-items: center; padding: 40px 24px; background: var(--color-bg); }
    .theme { position: absolute; top: 16px; right: 16px; }
    .card { width: min(420px, 100%); padding: 32px; gap: 18px; box-shadow: var(--shadow-md); }
    .or { display: flex; align-items: center; gap: 12px; color: var(--color-neutral-600); font-size: 12px; }
    .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--color-divider); }
    @media (max-width: 960px) {
      .wrap { grid-template-columns: 1fr; }
      .hero-in { padding: 28px 24px; gap: 24px; }
      .pitch h1 { font-size: 30px; }
      .facts, .legal { display: none; }
    }
  `]
})
export class LoginComponent {
  auth = inject(AuthService);
  theme = inject(ThemeService);
  roles = ROLES;
  role = signal('sup');
}
