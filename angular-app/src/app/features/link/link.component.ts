import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DOCS, NEW, MONTHS, docSummary, docYear } from '../../data/mock-data';
import { LandDoc } from '../../data/models';
import { RegistryStore } from '../../state/registry.store';
import { ViewerService } from '../../state/viewer.service';
import { ConfirmService } from '../../state/confirm.service';
import { AuthService } from '../../state/auth.service';
import { IconComponent } from '../../shared/icon.component';
import { CanDirective } from '../../shared/can.directive';
import { RbacService } from '../../state/rbac.service';


type Tab = 'documents' | 'chain' | 'comments';
type SFilter = 'all' | 'draft' | 'scanned' | 'verified' | 'finalized';

@Component({
  selector: 'app-link',
  standalone: true,
  imports: [IconComponent, CanDirective],
  template: `
    <div class="ws" [class.list-hidden]="!listOpen()">
      <!-- Land record list -->
      <aside class="list">
        <div class="list-head">
          <div class="row" style="justify-content:space-between">
            <h4 style="margin:0">Land records</h4>
            <button class="btn btn-primary" style="min-height:34px;padding:0 12px" appCan="record.create" (click)="openCreate()"><span style="font-size:18px;line-height:0">+</span>New record</button>
          </div>
          <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Erf, township or owner" [value]="q()" (input)="q.set($any($event.target).value)" aria-label="Search land records"></div>
          <div class="chips">
            @for (f of filters(); track f.id) {
              <button class="chip" [class.on]="sf() === f.id" (click)="sf.set(f.id)">{{ f.label }} <b>{{ f.n }}</b></button>
            }
          </div>
        </div>
        <div class="list-body">
          @for (r of visible(); track r.id) {
            <button class="rec" [class.on]="r.id === sel()?.id" (click)="select(r.id)">
              <span class="d" [class]="'d ' + r.st"></span>
              <span class="stack" style="gap:1px;min-width:0">
                <b class="ell">{{ r.erf }}, {{ r.township }}</b>
                <span class="small muted ell">{{ r.ownerList.length ? r.ownerList.join(', ') : 'No owners yet' }}</span>
              </span>
              <span class="stack" style="gap:2px;align-items:flex-end">
                <span class="small num muted">{{ r.docs }} doc{{ r.docs === 1 ? '' : 's' }}</span>
                @if (commentCount(r.id)) { <span class="cc">{{ commentCount(r.id) }} comment{{ commentCount(r.id) === 1 ? '' : 's' }}</span> }
              </span>
            </button>
          } @empty { <div class="small muted" style="padding:28px;text-align:center">No land records match.</div> }
        </div>
        <div class="list-foot small muted">{{ visible().length }} of {{ store.recordRows().length }} records</div>
      </aside>

      <!-- Selected record -->
      @if (sel(); as r) {
        <section class="main">
          <header class="panel head">
            <div class="stack" style="gap:6px;min-width:0">
              <div class="row" style="gap:10px">
                <button class="btn btn-ghost btn-icon tog" (click)="listOpen.set(!listOpen())" [title]="listOpen() ? 'Hide record list' : 'Show record list'"><app-icon [name]="listOpen() ? 'panelClose' : 'panelOpen'" [size]="18" /></button>
                <span class="card-kicker">ERP land record{{ r.live ? ' · version ' + (store.committed() ? 3 : 2) : '' }}</span>
                <span class="tag" [class]="'tag ' + r.tag">{{ r.label }}</span>
              </div>
              <h1 class="rt">{{ r.erf }}, {{ r.township }}</h1>
              <div class="meta">
                <span>Reg. division {{ r.regDiv }} · {{ r.region }}</span><span>Extent {{ r.extent }}</span><span>{{ r.tenure }}</span><span>{{ docs().length }} linked document{{ docs().length === 1 ? '' : 's' }}</span><span>Updated {{ r.lastActivity }}</span>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-secondary" appCan="record.link" (click)="tab.set('documents'); addOpen.set(true)"><app-icon name="search" [size]="16" />Add documents</button>
              <button class="btn btn-primary" [disabled]="!store.canFinalize(r) || r.st === 'finalized'" appCan="record.finalize" (click)="finalize(r)"><app-icon name="checkCircle" [size]="17" />{{ r.st === 'finalized' ? 'Finalized' : 'Finalize record' }}</button>
            </div>
          </header>

          <div class="body">
            <div class="stack" style="gap:16px;min-width:0">
              <nav class="tabs" role="tablist">
                <button role="tab" [class.on]="tab() === 'documents'" (click)="tab.set('documents')">Documents <span>{{ docs().length }}</span></button>
                <button role="tab" [class.on]="tab() === 'chain'" (click)="tab.set('chain')">Chain of title</button>
                <button role="tab" [class.on]="tab() === 'comments'" (click)="tab.set('comments')">Comments <span>{{ comments().length }}</span></button>
              </nav>

              @if (tab() === 'documents') {
                <div class="panel">
                  <div class="panel-head">
                    <h4>Linked documents</h4>
                    @if (docs().length) { <button class="btn btn-ghost" (click)="viewAll()"><app-icon name="eye" [size]="16" />View all</button> }
                  </div>
                  @if (docs().length) {
                    <div style="overflow-x:auto">
                      <table class="table">
                        <thead><tr><th>Document</th><th>Year</th><th>Parties / content</th><th>EDRMS ID</th><th>Status</th><th></th></tr></thead>
                        <tbody>
                          @for (d of docs(); track d.id) {
                            <tr>
                              <td><div class="dcell"><span class="di"><app-icon name="file" [size]="16" /></span><span class="stack" style="gap:0"><b class="num">{{ d.ref }}</b><span class="small muted">{{ d.title }}</span></span></div></td>
                              <td class="num">{{ year(d) }}</td>
                              <td style="font-size:13.5px;max-width:320px">{{ summary(d) }}</td>
                              <td class="small muted num">{{ store.isFiled(d) ? d.edrms : '—' }}</td>
                              <td><span class="tag" [class.tag-accent]="store.isFiled(d)" [class.tag-neutral]="!store.isFiled(d)">{{ store.isFiled(d) ? 'Filed' : 'In review' }}</span></td>
                              <td style="text-align:right;white-space:nowrap">
                                <button class="btn btn-ghost btn-icon" title="View document" (click)="viewer.open('record', d.id, 0, r.id)"><app-icon name="eye" [size]="17" /></button>
                                <button class="btn btn-ghost btn-icon danger" title="Remove from record" appCan="record.unlink" (click)="remove(r.id, d)"><app-icon name="x" [size]="17" /></button>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  } @else {
                    <div class="empty"><app-icon name="layers" [size]="28" /><b>No documents linked yet</b><span class="muted small">Search the EDRMS below and add the deeds, grants and diagrams that make up this record.</span></div>
                  }
                </div>

                <div class="panel">
                  <button class="panel-head add-head" (click)="addOpen.set(!addOpen())">
                    <span class="stack" style="gap:2px;text-align:left"><h4>Add documents from the EDRMS</h4><span class="small muted">{{ pool().length }} filed or in-review documents not linked to any land record</span></span>
                    <span class="chev" [class.open]="addOpen()">▾</span>
                  </button>
                  @if (addOpen()) {
                    <div class="panel-body stack" style="gap:12px">
                      <div class="row">
                        <div class="search" style="flex:1;min-width:220px"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="dq()" (input)="dq.set($any($event.target).value)" aria-label="Search EDRMS documents"></div>
                        <div class="seg">
                          <label class="seg-opt"><input type="radio" name="pf" [checked]="matchOnly()" (change)="matchOnly.set(true)">Matching this parcel</label>
                          <label class="seg-opt"><input type="radio" name="pf" [checked]="!matchOnly()" (change)="matchOnly.set(false)">All unlinked</label>
                        </div>
                      </div>
                      <div class="results">
                        @for (p of results(); track p.doc.id) {
                          <div class="res" [class.match]="p.score >= 90">
                            <span class="score num" [class.hi]="p.score >= 90">{{ p.score ? p.score + '%' : '—' }}</span>
                            <div class="stack" style="gap:2px;min-width:0">
                              <span class="row" style="gap:8px"><b class="num">{{ p.doc.ref }}</b><span class="small muted">{{ p.doc.title }} · {{ year(p.doc) }}</span></span>
                              <span style="font-size:13px" class="ell">{{ p.prop }} · {{ summary(p.doc) }}</span>
                              @if (p.reason) { <span class="small" style="color:var(--color-accent-700)">{{ p.reason }}</span> }
                            </div>
                            <div class="row" style="gap:6px;flex-wrap:nowrap">
                              <button class="btn btn-ghost btn-icon" title="Preview" (click)="viewer.open('pool', p.doc.id, 0, r.id)"><app-icon name="eye" [size]="17" /></button>
                              @if (p.filed) {
                                @if (p.suggested) { <button class="btn btn-ghost" style="min-height:34px" appCan="record.link" (click)="store.reject(p.doc.id)">Not this parcel</button> }
                                <button class="btn btn-secondary" appCan="record.link" (click)="store.addDocToRecord(r.id, p.doc.id)">+ Add</button>
                              } @else {
                                <span class="tag tag-neutral" title="Finish metadata verification first">In review</span>
                              }
                            </div>
                          </div>
                        } @empty {
                          <div class="small muted" style="padding:18px;text-align:center">{{ matchOnly() ? 'No unlinked documents match this parcel. Try “All unlinked”.' : 'No documents match your search.' }}</div>
                        }
                      </div>
                    </div>
                  }
                </div>
              }

              @if (tab() === 'chain') {
                <div class="panel panel-body">
                  @for (e of chain(); track e.doc.id; let last = $last) {
                    <div class="ev">
                      <div class="when"><b class="num">{{ e.year }}</b></div>
                      <div class="spine"><i></i><b [class.ok]="store.isFiled(e.doc)"></b>@if (!last) { <i style="flex:1"></i> }</div>
                      <div class="evc">
                        <div class="row" style="justify-content:space-between"><b>{{ e.doc.title }} · <span class="num">{{ e.doc.ref }}</span></b>
                          <button class="btn btn-ghost" style="min-height:30px" (click)="viewer.open('record', e.doc.id, 0, r.id)"><app-icon name="eye" [size]="15" />View</button></div>
                        <div style="font-size:13.5px;color:var(--color-neutral-800)">{{ summary(e.doc) }}</div>
                      </div>
                    </div>
                  } @empty { <div class="muted small" style="text-align:center;padding:18px">Link documents to build the chain of title.</div> }
                </div>
              }

              @if (tab() === 'comments') {
                <div class="panel">
                  <ul class="thread">
                    @for (c of comments(); track $index) {
                      <li>
                        <span class="av">{{ initials(c.who) }}</span>
                        <div class="stack" style="gap:3px;min-width:0">
                          <span class="row" style="gap:8px"><b>{{ c.who }}</b><span class="small muted">{{ c.role }} · {{ c.time }}</span></span>
                          <span style="font-size:14px;white-space:pre-wrap">{{ c.text }}</span>
                        </div>
                      </li>
                    } @empty { <li class="muted small" style="justify-content:center">No comments yet. Start the discussion for this record.</li> }
                  </ul>
                  <div class="composer">
                    <span class="av">{{ auth.role()?.initials }}</span>
                    <div class="stack" style="gap:8px;flex:1;min-width:0">
                      <textarea class="input" rows="3" [readonly]="!rbac.can('record.comment')" placeholder="Add a comment for reviewers, the registrar or auditors…" [value]="draft()" (input)="draft.set($any($event.target).value)" (keydown.control.enter)="post(r.id)" (keydown.meta.enter)="post(r.id)"></textarea>
                      <div class="row" style="justify-content:space-between"><span class="small muted">Visible to everyone with access to this record · Ctrl + Enter to post</span><button class="btn btn-primary" [disabled]="!draft().trim()" appCan="record.comment" (click)="post(r.id)">Post comment</button></div>
                    </div>
                  </div>
                </div>
              }
            </div>

            <aside class="stack side" style="gap:16px">
              <div class="panel">
                <div class="panel-head"><h4>Registered owners</h4></div>
                <div class="panel-body">
                  @if (owners().length) {
                    @for (o of owners(); track o.name) {
                      <div class="owner"><span class="av sm">{{ initials(o.name) }}</span><span class="stack" style="gap:0;min-width:0"><b class="ell">{{ o.name }}</b><span class="small muted num">{{ o.nid }}</span></span><b class="num">{{ o.frac }}</b></div>
                    }
                    <div class="shares">@for (o of owners(); track o.name; let i = $index) { <span [style.flex]="o.pct" [style.background]="colors[i % 3]" [title]="o.name"></span> }</div>
                  } @else { <span class="small muted">No owners until a title deed is linked.</span> }
                </div>
              </div>
              <div class="panel">
                <div class="panel-head"><h4>Record checks</h4><span class="small muted">{{ passing() }} / {{ checks().length }}</span></div>
                <div class="panel-body stack" style="gap:12px">
                  @for (c of checks(); track c.label) {
                    <div class="chk"><span class="check-mark" [class.ok]="c.state === 'ok'">{{ c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '–' }}</span><div><div style="font-size:13.5px;font-weight:600">{{ c.label }}</div><div class="small muted">{{ c.detail }}</div></div></div>
                  }
                </div>
              </div>
            </aside>
          </div>
        </section>
      }
    </div>

    @if (createOpen()) {
      <div class="dialog-backdrop" (click)="createOpen.set(false)">
        <form class="dialog" style="width:min(520px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); create()">
          <div class="dialog-title">New land record</div>
          <div class="dialog-body">Create the ERP record for a parcel, then add its documents from the EDRMS.</div>
          <div class="form-grid">
            <div class="field"><label>Erf / farm number</label><input class="input" [value]="nf().erf" (input)="setNf('erf', $any($event.target).value)" placeholder="e.g. Erf 2291" required></div>
            <div class="field"><label>Township</label><input class="input" [value]="nf().township" (input)="setNf('township', $any($event.target).value)" placeholder="e.g. Eros" required></div>
            <div class="field"><label>Registration division</label><select class="input" [value]="nf().regDiv" (change)="setNf('regDiv', $any($event.target).value)"><option>K</option><option>R</option><option>M</option></select></div>
            <div class="field"><label>Extent</label><input class="input" [value]="nf().extent" (input)="setNf('extent', $any($event.target).value)" placeholder="e.g. 850 m²"></div>
            <div class="field" style="grid-column:1/-1"><label>Tenure</label>
              <div class="seg"><label class="seg-opt"><input type="radio" name="ten" [checked]="nf().tenure === 'Freehold'" (change)="setNf('tenure', 'Freehold')">Freehold</label><label class="seg-opt"><input type="radio" name="ten" [checked]="nf().tenure === 'Leasehold'" (change)="setNf('tenure', 'Leasehold')">Leasehold</label><label class="seg-opt"><input type="radio" name="ten" [checked]="nf().tenure === 'Starter title'" (change)="setNf('tenure', 'Starter title')">Starter title</label></div>
            </div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="createOpen.set(false)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="!nf().erf.trim() || !nf().township.trim()">Create record</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .ws { display: grid; grid-template-columns: 320px minmax(0, 1fr); align-items: start; min-height: calc(100vh - var(--topbar-h)); }
    .ws.list-hidden { grid-template-columns: minmax(0, 1fr); }
    .ws.list-hidden .list { display: none; }
    .list { position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); display: flex; flex-direction: column; background: var(--color-surface); border-right: 1px solid var(--color-divider); }
    .list-head { padding: 16px; display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid var(--color-divider); }
    .search { position: relative; }
    .search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
    .search .input { padding-left: 34px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 99px; border: 1px solid var(--color-neutral-300); background: var(--color-surface); cursor: pointer; font-size: 12px; font-weight: 600; color: var(--color-neutral-800); }
    .chip b { color: var(--color-neutral-600); }
    .chip.on { background: var(--color-accent-100); border-color: var(--color-accent-300); color: var(--color-accent-700); }
    .list-body { flex: 1; overflow-y: auto; min-height: 0; }
    .rec { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 16px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid var(--color-divider); background: transparent; cursor: pointer; text-align: left; }
    .rec:hover { background: var(--color-neutral-100); }
    .rec.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rec b { font-size: 14px; }
    .ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cc { font-size: 11px; color: var(--color-neutral-600); }
    .d { width: 9px; height: 9px; border-radius: 50%; background: var(--color-neutral-400); }
    .d.scanned { background: var(--color-neutral-500); } .d.verified { background: var(--color-accent); } .d.finalized { background: var(--success); } .d.draft { background: transparent; border: 1.5px dashed var(--color-neutral-500); }
    .list-foot { padding: 10px 16px; border-top: 1px solid var(--color-divider); }
    .main { padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .head { padding: 18px 20px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
    .rt { font-size: 28px; margin: 0; letter-spacing: -.02em; }
    .meta { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 13.5px; color: var(--color-neutral-700); }
    .tog { width: 32px; height: 32px; margin-left: -6px; }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
    .side { position: sticky; top: calc(var(--topbar-h) + 16px); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-divider); }
    .tabs button { border: 0; background: transparent; padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--color-neutral-700); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: flex; gap: 8px; align-items: center; }
    .tabs button span { font-size: 11.5px; background: var(--color-neutral-200); color: var(--color-neutral-700); padding: 1px 7px; border-radius: 99px; }
    .tabs button:hover { color: var(--color-text); }
    .tabs button.on { color: var(--color-accent-600); border-bottom-color: var(--color-accent); }
    .tabs button.on span { background: var(--color-accent-100); color: var(--color-accent-700); }
    .dcell { display: flex; gap: 10px; align-items: center; }
    .di { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; flex: none; background: var(--color-accent-100); color: var(--color-accent-600); }
    .danger:hover { background: var(--danger-bg) !important; color: var(--danger) !important; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 20px; text-align: center; color: var(--color-neutral-600); }
    .empty b { color: var(--color-text); }
    .add-head { width: 100%; border: 0; background: transparent; cursor: pointer; border-bottom: 1px solid var(--color-divider); }
    .chev { font-size: 16px; color: var(--color-neutral-600); transition: transform .15s; transform: rotate(-90deg); }
    .chev.open { transform: none; }
    .results { display: flex; flex-direction: column; gap: 8px; }
    .res { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 12px; border: 1px solid var(--color-divider); border-radius: 10px; background: var(--color-surface); }
    .res.match { border-color: var(--color-accent-300); background: var(--color-accent-100); }
    .score { font-weight: 800; font-size: 14px; text-align: center; padding: 8px 0; border-radius: 8px; background: var(--color-neutral-200); color: var(--color-neutral-700); }
    .score.hi { background: var(--color-surface); color: var(--color-accent-600); }
    .ev { display: grid; grid-template-columns: 56px 18px minmax(0, 1fr); gap: 0 12px; }
    .when { padding-top: 12px; text-align: right; font-size: 16px; }
    .spine { display: flex; flex-direction: column; align-items: center; }
    .spine i { width: 2px; height: 16px; background: var(--color-divider); display: block; }
    .spine b { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--color-accent); background: var(--color-surface); display: block; }
    .spine b.ok { background: var(--color-accent); }
    .evc { padding: 10px 0 18px; }
    .thread { list-style: none; margin: 0; padding: 6px 18px; }
    .thread li { display: flex; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--color-divider); }
    .composer { display: flex; gap: 12px; padding: 16px 18px; background: var(--color-surface-2); border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
    .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-accent-500); color: #fff; }
    .av.sm { width: 30px; height: 30px; font-size: 11px; }
    .owner { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--color-divider); }
    .owner:last-of-type { border-bottom: 0; }
    .shares { display: flex; gap: 2px; height: 8px; border-radius: 99px; overflow: hidden; margin-top: 10px; }
    .chk { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; align-items: flex-start; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 4px; }
    @media (max-width: 1200px) { .body { grid-template-columns: 1fr; } .side { position: static; } }
    @media (max-width: 900px) {
      .ws { grid-template-columns: 1fr; }
      .list { position: static; height: auto; max-height: 360px; border-right: 0; border-bottom: 1px solid var(--color-divider); }
      .main { padding: 16px; }
      .res { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
    }
  `]
})
export class LinkComponent {
  store = inject(RegistryStore);
  rbac = inject(RbacService);
  viewer = inject(ViewerService);
  auth = inject(AuthService);
  private confirm = inject(ConfirmService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  selId = signal('erf1873');
  q = signal('');
  sf = signal<SFilter>('all');
  tab = signal<Tab>('documents');
  addOpen = signal(true);
  listOpen = signal(true);
  dq = signal('');
  matchOnly = signal(true);
  draft = signal('');
  createOpen = signal(false);
  nf = signal({ erf: '', township: '', regDiv: 'K', extent: '', tenure: 'Freehold' });
  colors = ['var(--color-accent-600)', 'var(--color-accent-400)', 'var(--color-accent-300)'];

  constructor() {
    this.route.queryParamMap.subscribe(p => { const r = p.get('record'); if (r) this.select(r); });
  }

  filters = computed(() => {
    const rows = this.store.recordRows(), n = (s: string) => rows.filter(r => r.st === s).length;
    return [
      { id: 'all' as SFilter, label: 'All', n: rows.length }, { id: 'scanned' as SFilter, label: 'Scanned', n: n('scanned') },
      { id: 'verified' as SFilter, label: 'Ready for review', n: n('verified') }, { id: 'finalized' as SFilter, label: 'Finalized', n: n('finalized') },
      ...(n('draft') ? [{ id: 'draft' as SFilter, label: 'Draft', n: n('draft') }] : [])
    ];
  });
  visible = computed(() => {
    const q = this.q().toLowerCase().trim(), f = this.sf();
    return this.store.recordRows().filter(r => (f === 'all' || r.st === f) && (!q || (r.erf + ' ' + r.township + ' ' + r.ownerList.join(' ')).toLowerCase().includes(q)));
  });
  sel = computed(() => this.store.recordRows().find(r => r.id === this.selId()) || this.store.recordRows()[0] || null);
  docs = computed<LandDoc[]>(() => { const r = this.sel(); this.store.recordRows(); return r ? this.store.recordDocIds(r.id).map(id => this.store.doc(id)!).filter(Boolean) : []; });
  chain = computed(() => [...this.docs()].sort((a, b) => docYear(a).localeCompare(docYear(b))).map(doc => ({ doc, year: docYear(doc) })));
  comments = computed(() => { const r = this.sel(); return r ? this.store.comments()[r.id] || [] : []; });
  owners = computed(() => {
    const r = this.sel(); if (!r) return [];
    if (r.live) return this.store.owners();
    return r.owners.map(name => ({ name, nid: this.fakeId(name), frac: r.owners.length === 2 ? '½' : '1/1', pct: 100 / r.owners.length }));
  });
  checks = computed(() => { const r = this.sel(); if (!r) return []; this.store.recordRows(); return r.live ? this.store.checks() : this.store.genericChecks(r); });
  passing = computed(() => this.checks().filter(c => c.state === 'ok').length);
  pool = computed(() => this.store.unassigned());
  results = computed(() => {
    const r = this.sel(); if (!r) return [];
    const q = this.dq().toLowerCase().trim(), erfNo = r.erf.toLowerCase();
    return this.pool().map(doc => {
      const prop = doc.fields.find(f => f.k === 'property' || f.k === 'sgNo')?.v || '';
      const same = prop.toLowerCase().startsWith(erfNo + ',') && prop.toLowerCase().includes(r.township.toLowerCase());
      const n = r.live ? NEW[doc.id] : null;
      const score = n ? parseInt(n.match, 10) : same ? 92 : prop.toLowerCase().includes(r.township.toLowerCase()) ? 34 : 0;
      const reason = n ? n.reasons : same ? 'Erf number and township match' : '';
      const suggested = !!n && this.store.linkState(doc.id) === 'suggested';
      return { doc, prop: doc.fields.find(f => f.k === 'property')?.v || '', score: n && !suggested ? 0 : score, reason: n && !suggested ? 'Dismissed for this parcel' : reason, filed: this.store.isFiled(doc), suggested };
    }).filter(p => (!this.matchOnly() || p.score >= 90) && (!q || (p.doc.ref + ' ' + p.prop + ' ' + docSummary(p.doc) + ' ' + p.doc.edrms).toLowerCase().includes(q)))
      .sort((a, b) => b.score - a.score);
  });

  year(d: LandDoc) { return docYear(d); }
  summary(d: LandDoc) { return docSummary(d); }
  initials(n: string) { return n.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase(); }
  fakeId(n: string) { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 1e9; return String(60 + (h % 40)).padStart(2, '0') + String(h).padStart(9, '0').slice(0, 9); }
  commentCount(id: string) { return (this.store.comments()[id] || []).length; }
  select(id: string) { this.selId.set(id); this.tab.set('documents'); this.dq.set(''); this.draft.set(''); }
  viewAll() { const r = this.sel(), d = this.docs()[0]; if (r && d) this.viewer.open('record', d.id, 0, r.id); }

  async remove(rid: string, d: LandDoc) {
    const r = this.sel()!;
    if (await this.confirm.ask({ title: 'Remove ' + d.ref + ' from ' + r.erf + '?', body: 'The document stays in the EDRMS and returns to the unlinked pool. ' + (r.st === 'finalized' ? 'The record will reopen as a new draft version.' : 'Ownership and checks are recalculated.'), confirmLabel: 'Remove document', tone: 'danger' }))
      this.store.removeDocFromRecord(rid, d.id);
  }
  async finalize(r: any) {
    const owners = this.owners().map(o => o.name + ' ' + o.frac).join(', ') || 'none recorded';
    if (await this.confirm.ask({ title: 'Finalize ' + r.erf + ', ' + r.township + '?', body: 'Registered owners: ' + owners + '. The finalized version becomes the basis for tokenization and can only be superseded, not edited.', confirmLabel: 'Finalize record' }))
      this.store.finalizeRecord(r);
  }
  post(rid: string) {
    if (!this.rbac.can('record.comment')) return;
    const t = this.draft().trim(); if (!t) return;
    const role = this.auth.role();
    this.store.addComment(rid, t, role?.name || 'J. !Gawaseb', role?.label || 'Records officer');
    this.draft.set('');
  }
  openCreate() { this.nf.set({ erf: '', township: '', regDiv: 'K', extent: '', tenure: 'Freehold' }); this.createOpen.set(true); }
  setNf(k: string, v: string) { this.nf.update(n => ({ ...n, [k]: v })); }
  create() {
    const n = this.nf(); if (!n.erf.trim() || !n.township.trim()) return;
    const erf = /^(erf|farm|portion)/i.test(n.erf.trim()) ? n.erf.trim() : 'Erf ' + n.erf.trim();
    const id = this.store.createRecord({ ...n, erf, township: n.township.trim(), extent: n.extent || '—' });
    this.createOpen.set(false); this.sf.set('all'); this.q.set(''); this.select(id); this.matchOnly.set(false);
  }
}
