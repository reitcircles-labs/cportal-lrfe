import { Component, computed, effect, inject, signal, untracked, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError, ApiService } from '../../api/api.service';
import { Check, Comment, Encumbrance, FoundDocument, LandRecord, Owner, ParcelKind, PinnedDocument, RecordSummary, RecordsApi } from '../../api/records.api';
import { ConfirmService } from '../../state/confirm.service';
import { ToastService } from '../../state/toast.service';
import { AuthService } from '../../state/auth.service';
import { RbacService, fmtTime } from '../../state/rbac.service';
import { IconComponent } from '../../shared/icon.component';
import { CanDirective } from '../../shared/can.directive';

type Tab = 'documents' | 'chain' | 'details' | 'comments';
type SFilter = 'all' | 'draft' | 'in_review' | 'committed' | 'needs_review';

const PARCEL_LABELS: Record<string, string> = {
  number: 'Erf number', portion: 'Portion', township: 'Township', regDiv: 'Registration division', region: 'Region',
  farmName: 'Farm name', farmNumber: 'Farm number', schemeName: 'Scheme name', schemeNumber: 'Scheme number', unit: 'Unit',
  participationQuota: 'Participation quota'
};
const ownerKey = (list: Owner[] | null | undefined) => JSON.stringify((list || []).map(o => [o.name.toLowerCase(), o.share, o.idNo ?? null]).sort());

/**
 * Land records (#/link) on the land-records service: list and search records; a record's documents
 * (pinned EDRMS versions), chain of title, details, owners and checks; build a draft from filed
 * documents, accept or override the suggested owners and extent, submit it for review, withdraw it,
 * and open a change on a committed record. The review itself happens in the task inbox.
 */
@Component({
    selector: 'app-link',
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
          <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Record no., parcel, owner or deed" [value]="q()" (input)="search($any($event.target).value)" aria-label="Search land records"></div>
          <div class="chips">
            @for (f of filters(); track f.id) {
              <button class="chip" [class.on]="sf() === f.id" (click)="sf.set(f.id)">{{ f.label }} <b>{{ f.n }}</b></button>
            }
          </div>
        </div>
        <div class="list-body">
          @for (r of visible(); track r.id) {
            <button class="rec" [class.on]="r.id === selId()" (click)="select(r.id)">
              <span class="d" [class]="'d ' + dot(r)"></span>
              <span class="stack" style="gap:1px;min-width:0">
                <b class="ell">{{ r.label }}</b>
                <span class="small muted ell num">{{ r.recordNo }}</span>
              </span>
              <span class="tag" [class]="'tag ' + statusOf(r).tag">{{ statusOf(r).label }}</span>
            </button>
          } @empty { <div class="small muted" style="padding:28px;text-align:center">{{ loading() ? 'Loading…' : 'No land records match.' }}</div> }
        </div>
        <div class="list-foot small muted">{{ visible().length }} of {{ records().length }} records</div>
      </aside>

      <!-- Selected record -->
      @if (rec(); as r) {
        <section class="main">
          <header class="panel head">
            <div class="stack" style="gap:6px;min-width:0">
              <div class="row" style="gap:10px">
                <button class="btn btn-ghost btn-icon tog" (click)="listOpen.set(!listOpen())" [title]="listOpen() ? 'Hide record list' : 'Show record list'"><app-icon [name]="listOpen() ? 'panelClose' : 'panelOpen'" [size]="18" /></button>
                <span class="card-kicker num">{{ r.recordNo }} · {{ versionLabel() }}</span>
                <span class="tag" [class]="'tag ' + statusOf(r).tag">{{ statusOf(r).label }}</span>
              </div>
              <h1 class="rt">{{ r.label }}</h1>
              <div class="meta">
                @if (data()?.parcel?.regDiv) { <span>Reg. division {{ data()!.parcel.regDiv }}{{ data()!.parcel.region ? ' · ' + data()!.parcel.region : '' }}</span> }
                <span>Extent {{ extentText(data()?.extent) }}</span>
                <span>{{ tenureLabel(data()?.tenure) }}</span>
                <span>{{ docs().length }} linked document{{ docs().length === 1 ? '' : 's' }}</span>
                <span>Updated {{ fmt(r.updatedAt) }}</span>
              </div>
            </div>
            <div class="row">
              @if (editable()) {
                <button class="btn btn-secondary" appCan="record.link" (click)="tab.set('documents'); addOpen.set(true)"><app-icon name="search" [size]="16" />Add documents</button>
                <button class="btn btn-primary" appCan="record.link" [disabled]="busy() || failing().length > 0" [title]="failing().length ? 'Every required check must pass first' : ''" (click)="submit()"><app-icon name="checkCircle" [size]="17" />Submit for review</button>
              } @else if (r.draftState === 'in_review') {
                @if (isSubmitter()) { <button class="btn btn-secondary" appCan="record.link" [disabled]="busy()" (click)="withdraw()">Withdraw from review</button> }
                <span class="small muted">Waiting for approval by a second person</span>
              } @else if (r.status === 'committed' && !r.draftVersion) {
                <button class="btn btn-secondary" appCan="record.link" [disabled]="busy()" (click)="change()">Change record</button>
              }
            </div>
          </header>

          @if (r.draft?.reviewComment && r.draft?.state === 'draft') {
            <div class="note warn" role="status"><b>Returned by the reviewer:</b> {{ r.draft!.reviewComment }}</div>
          }
          @for (f of r.flags; track f.edrmsDocumentId) {
            <div class="note warn" role="status"><b>{{ f.message }}</b>{{ f.reason ? ' Reason: ' + f.reason + '.' : '' }}
              {{ editable() ? 'Use the newer version in the documents below.' : r.draftVersion ? '' : 'Change the record to take it over.' }}</div>
          }

          <div class="body">
            <div class="stack" style="gap:16px;min-width:0">
              <nav class="tabs" role="tablist">
                <button role="tab" [attr.aria-selected]="tab() === 'documents'" [class.on]="tab() === 'documents'" (click)="tab.set('documents')">Documents <span>{{ docs().length }}</span></button>
                <button role="tab" [attr.aria-selected]="tab() === 'chain'" [class.on]="tab() === 'chain'" (click)="tab.set('chain')">Chain of title</button>
                <button role="tab" [attr.aria-selected]="tab() === 'details'" [class.on]="tab() === 'details'" (click)="tab.set('details')">Details</button>
                <button role="tab" [attr.aria-selected]="tab() === 'comments'" [class.on]="tab() === 'comments'" (click)="tab.set('comments'); loadComments()">Comments <span>{{ comments().length }}</span></button>
              </nav>

              @if (tab() === 'documents') {
                <div class="panel">
                  <div class="panel-head"><h4>Linked documents</h4></div>
                  @if (docs().length) {
                    <div style="overflow-x:auto">
                      <table class="table">
                        <thead><tr><th>Document</th><th>Property</th><th>EDRMS ID</th><th></th></tr></thead>
                        <tbody>
                          @for (d of docs(); track d.edrmsDocumentId) {
                            <tr>
                              <td><div class="dcell"><span class="di"><app-icon name="file" [size]="16" /></span><span class="stack" style="gap:0"><b class="num">{{ d.ref || d.edrmsNo }}</b><span class="small muted">{{ typeLabel(d.docType) }}</span></span></div></td>
                              <td style="font-size:13.5px">{{ d.fields['property'] || '—' }}</td>
                              <td class="small muted num">{{ d.edrmsNo }} · v{{ d.version }}.0</td>
                              <td style="text-align:right;white-space:nowrap">
                                @if (newer(d); as to) {
                                  @if (editable()) { <button class="btn btn-secondary" style="min-height:32px" appCan="record.link" [disabled]="busy()" (click)="refresh(d)">Use v{{ to }}.0</button> }
                                  @else { <span class="tag tag-outline">v{{ to }}.0 in EDRMS</span> }
                                }
                                <button class="btn btn-ghost btn-icon" title="View document" aria-label="View document" (click)="view(d.edrmsDocumentId, d.version)"><app-icon name="eye" [size]="17" /></button>
                                @if (editable()) { <button class="btn btn-ghost btn-icon danger" title="Remove from record" aria-label="Remove from record" appCan="record.unlink" (click)="remove(d)"><app-icon name="x" [size]="17" /></button> }
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

                @if (editable()) {
                  <div class="panel">
                    <button class="panel-head add-head" (click)="addOpen.set(!addOpen())">
                      <span class="stack" style="gap:2px;text-align:left"><h4>Add documents from the EDRMS</h4><span class="small muted">Filed documents, found by their verified details</span></span>
                      <span class="chev" [class.open]="addOpen()">▾</span>
                    </button>
                    @if (addOpen()) {
                      <div class="panel-body stack" style="gap:12px">
                        <div class="row">
                          <div class="seg">
                            <label class="seg-opt"><input type="radio" name="pf" [checked]="mode() === 'match'" (change)="setMode('match')">Matching this parcel</label>
                            <label class="seg-opt"><input type="radio" name="pf" [checked]="mode() === 'search'" (change)="setMode('search')">Search</label>
                          </div>
                          @if (mode() === 'search') {
                            <div class="search" style="flex:1;min-width:220px"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="dq()" (input)="searchDocs($any($event.target).value)" aria-label="Search EDRMS documents"></div>
                          }
                        </div>
                        <div class="results">
                          @for (p of found(); track p.edrmsDocumentId) {
                            <div class="res" [class.match]="!!p.reasons?.length && !p.inThisRecord">
                              <div class="stack" style="gap:2px;min-width:0">
                                <span class="row" style="gap:8px"><b class="num">{{ p.ref || p.edrmsNo }}</b><span class="small muted">{{ typeLabel(p.docType) }} · {{ p.edrmsNo }}</span></span>
                                <span style="font-size:13px" class="ell">{{ p.property || p.title }}</span>
                                @for (why of p.reasons || []; track why) { <span class="small" style="color:var(--color-accent-700)">{{ why }}</span> }
                                @if (p.linkedTo.length) { <span class="small muted">Also in {{ linkedText(p) }}</span> }
                              </div>
                              <div class="row" style="gap:6px;flex-wrap:nowrap">
                                <button class="btn btn-ghost btn-icon" title="Preview" aria-label="Preview" (click)="view(p.edrmsDocumentId)"><app-icon name="eye" [size]="17" /></button>
                                @if (p.inThisRecord) { <span class="tag tag-info">In this record</span> }
                                @else { <button class="btn btn-secondary" appCan="record.link" [disabled]="busy()" (click)="add(p)">+ Add</button> }
                              </div>
                            </div>
                          } @empty {
                            <div class="small muted" style="padding:18px;text-align:center">{{ finding() ? 'Searching…' : mode() === 'match' ? 'No filed documents match this parcel yet. Try Search.' : dq().trim() ? 'No documents match your search.' : 'Type to search the EDRMS.' }}</div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              }

              @if (tab() === 'chain') {
                <div class="panel panel-body">
                  @for (e of chain(); track e.ref; let last = $last) {
                    <div class="ev">
                      <div class="when"><b class="num">{{ e.date ? e.date.slice(0, 4) : '—' }}</b></div>
                      <div class="spine"><i></i><b class="ok"></b>@if (!last) { <i style="flex:1"></i> }</div>
                      <div class="evc">
                        <div class="row" style="justify-content:space-between"><b>{{ typeLabel(e.docType) }} · <span class="num">{{ e.ref }}</span></b>
                          <button class="btn btn-ghost" style="min-height:30px" (click)="viewByNo(e.edrmsNo)"><app-icon name="eye" [size]="15" />View</button></div>
                        <div style="font-size:13.5px;color:var(--color-neutral-800)">
                          {{ e.transferor ? e.transferor + ' → ' : '' }}{{ e.holders.join(', ') || '—' }}{{ e.regDate ? ' · registered ' + e.regDate : '' }}{{ e.priorTitle ? ' · held under ' + e.priorTitle : '' }}
                        </div>
                      </div>
                    </div>
                  } @empty { <div class="muted small" style="text-align:center;padding:18px">Link title deeds to build the chain of title.</div> }
                  @for (n of shown()?.derived?.notes || []; track n) { <div class="small muted" style="padding-top:6px">{{ n }}</div> }
                </div>
              }

              @if (tab() === 'details') {
                <div class="panel">
                  <div class="panel-head"><h4>Parcel</h4></div>
                  <div class="panel-body kv">
                    @for (k of parcelKeys(); track k) { <span>{{ parcelLabel(k) }}</span><span>{{ data()!.parcel[k] }}</span> }
                  </div>
                </div>
                <form class="panel" (submit)="$event.preventDefault(); saveDetails()">
                  <div class="panel-head"><h4>Details</h4>@if (!editable()) { <span class="small muted">Change the record to edit</span> }</div>
                  <div class="panel-body stack" style="gap:14px">
                    <div class="form-grid">
                      <div class="field"><label for="ten">Tenure</label>
                        <select id="ten" class="input" [disabled]="!editable()" [value]="df().tenure" (change)="setDf('tenure', $any($event.target).value)">
                          <option value="">—</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="other">Other</option>
                        </select></div>
                      <div class="field"><label for="ext">Extent</label>
                        <div class="row" style="gap:6px;flex-wrap:nowrap">
                          <input id="ext" class="input num" inputmode="decimal" [readonly]="!editable()" [value]="df().extent" (input)="setDf('extent', $any($event.target).value)">
                          <select class="input" style="width:90px" aria-label="Extent unit" [disabled]="!editable()" [value]="df().unit" (change)="setDf('unit', $any($event.target).value)"><option value="m2">m²</option><option value="ha">ha</option></select>
                        </div>
                        @if (shown()?.data?.extent?.source; as s) { <span class="small muted">{{ s.from === 'document' ? 'From ' + s.edrmsNo : 'Entered by hand' + (s.reason ? ': ' + s.reason : '') }}</span> }
                        @if (editable() && suggestedExtentDiffers()) {
                          <button type="button" class="btn btn-ghost" style="min-height:30px;justify-self:start" appCan="record.link" (click)="accept('extent')">Use {{ extentText(shown()!.derived!.extent) }} from the documents</button>
                        }
                      </div>
                    </div>
                    <div class="stack" style="gap:6px">
                      <b style="font-size:13.5px">Encumbrances</b>
                      @for (e of df().encumbrances; track $index; let i = $index) {
                        <div class="row" style="gap:6px;flex-wrap:nowrap">
                          <select class="input" style="width:130px" aria-label="Type" [disabled]="!editable()" [value]="e.type" (change)="setEnc(i, 'type', $any($event.target).value)"><option value="bond">Bond</option><option value="servitude">Servitude</option><option value="other">Other</option></select>
                          <input class="input" placeholder="Reference" aria-label="Reference" [readonly]="!editable()" [value]="e.ref" (input)="setEnc(i, 'ref', $any($event.target).value)">
                          <input class="input" placeholder="In favour of" aria-label="In favour of" [readonly]="!editable()" [value]="e.inFavourOf || ''" (input)="setEnc(i, 'inFavourOf', $any($event.target).value)">
                          @if (editable()) { <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="removeEnc(i)"><app-icon name="x" [size]="16" /></button> }
                        </div>
                      } @empty { <span class="small muted">None</span> }
                      @if (editable()) { <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="addEnc()">+ Add encumbrance</button> }
                    </div>
                    <div class="stack" style="gap:6px">
                      <b style="font-size:13.5px">Other attributes</b>
                      @for (a of df().attributes; track $index; let i = $index) {
                        <div class="row" style="gap:6px;flex-wrap:nowrap">
                          <input class="input" placeholder="Name, e.g. zoning" aria-label="Attribute name" [readonly]="!editable()" [value]="a.k" (input)="setAttr(i, 'k', $any($event.target).value)">
                          <input class="input" placeholder="Value" aria-label="Attribute value" [readonly]="!editable()" [value]="a.v" (input)="setAttr(i, 'v', $any($event.target).value)">
                          @if (editable()) { <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="removeAttr(i)"><app-icon name="x" [size]="16" /></button> }
                        </div>
                      } @empty { <span class="small muted">None</span> }
                      @if (editable()) { <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="addAttr()">+ Add attribute</button> }
                    </div>
                    @if (editable()) {
                      @if (extentByHand()) {
                        <div class="field"><label for="dreason">Reason for the extent entered by hand</label><input id="dreason" class="input" [value]="df().reason" (input)="setDf('reason', $any($event.target).value)" placeholder="e.g. as on the approved diagram"></div>
                      }
                      <div class="row" style="justify-content:flex-end"><button type="submit" class="btn btn-primary" appCan="record.link" [disabled]="busy()">Save details</button></div>
                    }
                  </div>
                </form>
              }

              @if (tab() === 'comments') {
                <div class="panel">
                  <ul class="thread">
                    @for (c of comments(); track c.id) {
                      <li>
                        <span class="av">{{ initials(c.authorName || '?') }}</span>
                        <div class="stack" style="gap:3px;min-width:0">
                          <span class="row" style="gap:8px"><b>{{ c.authorName }}</b><span class="small muted">{{ fmt(c.createdAt) }}{{ c.versionNumber ? ' · version ' + c.versionNumber : '' }}</span></span>
                          <span style="font-size:14px;white-space:pre-wrap">{{ c.body }}</span>
                        </div>
                      </li>
                    } @empty { <li class="muted small" style="justify-content:center">No comments yet. Start the discussion for this record.</li> }
                  </ul>
                  <div class="composer">
                    <span class="av">{{ auth.role()?.initials }}</span>
                    <div class="stack" style="gap:8px;flex:1;min-width:0">
                      <textarea class="input" rows="3" aria-label="Comment" [readonly]="!rbac.can('record.comment')" placeholder="Add a comment for reviewers, the registrar or auditors…" [value]="draftText()" (input)="draftText.set($any($event.target).value)" (keydown.control.enter)="post()" (keydown.meta.enter)="post()"></textarea>
                      <div class="row" style="justify-content:space-between"><span class="small muted">Visible to everyone with access to this record · Ctrl + Enter to post</span><button class="btn btn-primary" [disabled]="!draftText().trim()" appCan="record.comment" (click)="post()">Post comment</button></div>
                    </div>
                  </div>
                </div>
              }
            </div>

            <aside class="stack side" style="gap:16px">
              <div class="panel">
                <div class="panel-head"><h4>Registered owners</h4>@if (editable()) { <button class="btn btn-ghost" style="min-height:30px" appCan="record.link" (click)="editOwners()">Edit</button> }</div>
                <div class="panel-body">
                  @if (owners().length) {
                    @for (o of owners(); track o.name) {
                      <div class="owner"><span class="av sm">{{ initials(o.name) }}</span>
                        <span class="stack" style="gap:0;min-width:0"><b class="ell">{{ o.name }}</b><span class="small muted num">{{ o.idNo || 'No ID number' }}</span>
                          <span class="small" [style.color]="o.source?.from === 'manual' ? 'var(--warn-fg)' : 'var(--color-neutral-600)'" [title]="o.source?.reason || ''">{{ o.source?.from === 'manual' ? 'Entered by hand' : o.since ? 'Under ' + o.since : 'From the documents' }}</span></span>
                        <b class="num">{{ o.share }}</b></div>
                    }
                  } @else { <span class="small muted">No owners yet.</span> }
                  @if (editable() && suggestedOwnersDiffer()) {
                    <div class="sugg">
                      <span class="small"><b>From the documents:</b> {{ suggestedOwnersText() }}</span>
                      <button class="btn btn-secondary" style="min-height:32px" appCan="record.link" [disabled]="busy()" (click)="accept('owners')">Use these owners</button>
                    </div>
                  }
                </div>
              </div>
              <div class="panel">
                <div class="panel-head"><h4>Record checks</h4><span class="small muted">{{ passing() }} / {{ required().length }} required</span></div>
                <div class="panel-body stack" style="gap:12px">
                  @for (c of checks(); track c.id) {
                    <div class="chk"><span class="check-mark" [class.ok]="c.ok" [class.bad]="!c.ok && c.level === 'error'">{{ c.ok ? '✓' : c.level === 'error' ? '✕' : '!' }}</span>
                      <div><div style="font-size:13.5px;font-weight:600">{{ checkLabel(c) }}</div><div class="small muted">{{ c.message }}</div></div></div>
                  } @empty { <span class="small muted">No checks yet.</span> }
                </div>
              </div>
            </aside>
          </div>
        </section>
      } @else if (!loading()) {
        <section class="main"><div class="panel empty"><app-icon name="layers" [size]="28" /><b>No land record selected</b><span class="muted small">Pick a record from the list, or create one for a parcel.</span></div></section>
      }
    </div>

    @if (createOpen()) {
      <div class="dialog-backdrop" (click)="createOpen.set(false)">
        <form class="dialog" style="width:min(560px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); create()">
          <div class="dialog-title">New land record</div>
          <div class="seg" style="margin:4px 0 10px">
            <label class="seg-opt"><input type="radio" name="cm" [checked]="cmode() === 'doc'" (change)="cmode.set('doc')">From a filed document</label>
            <label class="seg-opt"><input type="radio" name="cm" [checked]="cmode() === 'parcel'" (change)="cmode.set('parcel')">For a parcel</label>
          </div>
          @if (cmode() === 'doc') {
            <div class="dialog-body">The parcel is read from the document, and the document is linked to the new record.</div>
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="cq()" (input)="searchCreate($any($event.target).value)" aria-label="Find a filed document"></div>
            <div class="results" style="max-height:280px;overflow-y:auto;margin-top:10px">
              @for (p of cfound(); track p.edrmsDocumentId) {
                <label class="res pick" [class.match]="cpick() === p.edrmsDocumentId">
                  <input type="radio" name="cpick" [checked]="cpick() === p.edrmsDocumentId" (change)="cpick.set(p.edrmsDocumentId)">
                  <span class="stack" style="gap:2px;min-width:0"><b class="num">{{ p.ref || p.edrmsNo }}</b><span class="small muted ell">{{ typeLabel(p.docType) }} · {{ p.property || p.title }}</span>
                    @if (p.linkedTo.length) { <span class="small muted">Already in {{ linkedText(p) }}</span> }</span>
                </label>
              } @empty { <div class="small muted" style="padding:12px;text-align:center">{{ cq().trim() ? 'No documents match.' : 'Type to search the EDRMS.' }}</div> }
            </div>
          } @else {
            <div class="form-grid">
              <div class="field" style="grid-column:1/-1"><label for="kind">Kind of parcel</label>
                <select id="kind" class="input" [value]="ckind()" (change)="ckind.set($any($event.target).value)">
                  @for (k of kinds(); track k.id) { <option [value]="k.id">{{ k.label }}</option> }
                </select></div>
              @for (f of kindFields(); track f.k) {
                <div class="field"><label [for]="'pf-' + f.k">{{ parcelLabel(f.k) }}{{ f.required ? '' : ' (optional)' }}</label>
                  <input class="input" [id]="'pf-' + f.k" [value]="cparcel()[f.k] || ''" (input)="setParcel(f.k, $any($event.target).value)"></div>
              }
            </div>
          }
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="createOpen.set(false)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !canCreate()">Create record</button>
          </div>
        </form>
      </div>
    }

    @if (ownerForm(); as of) {
      <div class="dialog-backdrop" (click)="ownerForm.set(null)">
        <form class="dialog" style="width:min(640px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); saveOwners()">
          <div class="dialog-title">Registered owners</div>
          <div class="dialog-body">Owners that differ from what the documents say are marked as entered by hand and shown to the reviewer.</div>
          <div class="stack" style="gap:8px">
            @for (o of of.owners; track $index; let i = $index) {
              <div class="orow">
                <input class="input" placeholder="Name" aria-label="Owner name" [value]="o.name" (input)="setOwner(i, 'name', $any($event.target).value)">
                <input class="input num" placeholder="ID number" aria-label="ID number" [value]="o.idNo || ''" (input)="setOwner(i, 'idNo', $any($event.target).value)">
                <input class="input num" placeholder="Share, e.g. 1/2" aria-label="Share" [value]="o.share" (input)="setOwner(i, 'share', $any($event.target).value)">
                <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="removeOwner(i)"><app-icon name="x" [size]="16" /></button>
              </div>
            }
            <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="addOwner()">+ Add owner</button>
            <div class="field"><label for="oreason">Reason (needed for owners not as in the documents)</label><input id="oreason" class="input" [value]="of.reason" (input)="setOwnerReason($any($event.target).value)"></div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="ownerForm.set(null)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy()">Save owners</button>
          </div>
        </form>
      </div>
    }
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
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
    .rec .tag { font-size: 11px; }
    .ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .d { width: 9px; height: 9px; border-radius: 50%; background: var(--color-neutral-400); }
    .d.review { background: var(--color-accent); } .d.committed { background: var(--success); } .d.flag { background: var(--nam-red, #c0392b); } .d.draft { background: transparent; border: 1.5px dashed var(--color-neutral-500); }
    .list-foot { padding: 10px 16px; border-top: 1px solid var(--color-divider); }
    .main { padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .head { padding: 18px 20px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
    .rt { font-size: 28px; margin: 0; letter-spacing: -.02em; }
    .meta { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 13.5px; color: var(--color-neutral-700); }
    .tog { width: 32px; height: 32px; margin-left: -6px; }
    .note { padding: 10px 14px; border-radius: 10px; font-size: 13.5px; }
    .note.warn { background: var(--warn-bg); color: var(--warn-fg); border: 1px solid var(--warn-bd); }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
    .side { position: sticky; top: calc(var(--topbar-h) + 16px); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-divider); overflow-x: auto; }
    .tabs button { border: 0; background: transparent; padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--color-neutral-700); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: flex; gap: 8px; align-items: center; white-space: nowrap; }
    .tabs button span { font-size: 11.5px; background: var(--color-neutral-200); color: var(--color-neutral-700); padding: 1px 7px; border-radius: 99px; }
    .tabs button:hover { color: var(--color-text); }
    .tabs button.on { color: var(--color-accent-600); border-bottom-color: var(--color-accent); }
    .tabs button.on span { background: var(--color-accent-100); color: var(--color-accent-700); }
    .dcell { display: flex; gap: 10px; align-items: center; }
    .dcell b { white-space: nowrap; }
    .di { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; flex: none; background: var(--color-accent-100); color: var(--color-accent-600); }
    .danger:hover { background: var(--danger-bg) !important; color: var(--danger) !important; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 20px; text-align: center; color: var(--color-neutral-600); }
    .empty b { color: var(--color-text); }
    .add-head { width: 100%; border: 0; background: transparent; cursor: pointer; border-bottom: 1px solid var(--color-divider); }
    .chev { font-size: 16px; color: var(--color-neutral-600); transition: transform .15s; transform: rotate(-90deg); }
    .chev.open { transform: none; }
    .results { display: flex; flex-direction: column; gap: 8px; }
    .res { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 12px; border: 1px solid var(--color-divider); border-radius: 10px; background: var(--color-surface); }
    .res.match { border-color: var(--color-accent-300); background: var(--color-accent-100); }
    .res.pick { grid-template-columns: auto minmax(0, 1fr); cursor: pointer; }
    .ev { display: grid; grid-template-columns: 56px 18px minmax(0, 1fr); gap: 0 12px; }
    .when { padding-top: 12px; text-align: right; font-size: 16px; }
    .spine { display: flex; flex-direction: column; align-items: center; }
    .spine i { width: 2px; height: 16px; background: var(--color-divider); display: block; }
    .spine b { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--color-accent); background: var(--color-surface); display: block; }
    .spine b.ok { background: var(--color-accent); }
    .evc { padding: 10px 0 18px; }
    .kv { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 6px 14px; font-size: 14px; }
    .kv span:nth-child(odd) { color: var(--color-neutral-600); }
    .thread { list-style: none; margin: 0; padding: 6px 18px; }
    .thread li { display: flex; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--color-divider); }
    .composer { display: flex; gap: 12px; padding: 16px 18px; background: var(--color-surface-2); border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
    .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-accent-500); color: #fff; }
    .av.sm { width: 30px; height: 30px; font-size: 11px; }
    .owner { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--color-divider); }
    .owner:last-of-type { border-bottom: 0; }
    .sugg { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--color-accent-100); border: 1px solid var(--color-accent-300); }
    .chk { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; align-items: flex-start; }
    .check-mark.bad { background: var(--danger-bg); color: var(--danger); border-color: var(--danger-bd); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 4px; }
    .orow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 6px; }
    /* with the app's sidebar and the record list, the record itself is narrow below about 1440px */
    @media (max-width: 1440px) { .body { grid-template-columns: 1fr; } .side { position: static; } }
    @media (max-width: 900px) {
      .ws { grid-template-columns: 1fr; }
      .list { position: static; height: auto; max-height: 360px; border-right: 0; border-bottom: 1px solid var(--color-divider); }
      .main { padding: 16px; }
      .res { grid-template-columns: 1fr; }
      .form-grid, .orow { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 1fr; }
    }
  `]
})
export class LinkComponent {
  private records$ = inject(RecordsApi);
  private api = inject(ApiService);
  rbac = inject(RbacService);
  auth = inject(AuthService);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  records = signal<RecordSummary[]>([]);
  loading = signal(true);
  q = signal('');
  sf = signal<SFilter>('all');
  selId = signal<string | null>(null);
  rec = signal<LandRecord | null>(null);
  tab = signal<Tab>('documents');
  listOpen = signal(true);
  busy = signal(false);
  docTypes = signal<{ id: string; label: string }[]>([]);
  // adding documents
  addOpen = signal(true);
  mode = signal<'match' | 'search'>('match');
  dq = signal('');
  found = signal<FoundDocument[]>([]);
  finding = signal(false);
  // comments
  comments = signal<Comment[]>([]);
  draftText = signal('');
  // details form
  df = signal<{ tenure: string; extent: string; unit: string; reason: string; encumbrances: Encumbrance[]; attributes: { k: string; v: string; orig?: any }[] }>({ tenure: '', extent: '', unit: 'm2', reason: '', encumbrances: [], attributes: [] });
  // owners dialog
  ownerForm = signal<{ owners: Owner[]; reason: string } | null>(null);
  // create dialog
  createOpen = signal(false);
  cmode = signal<'doc' | 'parcel'>('doc');
  cq = signal('');
  cfound = signal<FoundDocument[]>([]);
  cpick = signal<string | null>(null);
  kinds = signal<ParcelKind[]>([]);
  ckind = signal('erf');
  cparcel = signal<Record<string, string>>({});

  private timers: Record<string, any> = {};
  fmt = fmtTime;

  constructor() {
    this.route.queryParamMap.subscribe(p => { const r = p.get('record'); if (r && r !== this.selId()) this.select(r); });
    this.api.get<{ docTypes: { id: string; label: string }[] }>('/document-catalogue').then(c => this.docTypes.set(c.docTypes)).catch(() => {});
    this.loadList();
    // keep the details form in step with the record shown
    // (not on every change: unsaved details survive adding a document or saving owners)
    effect(() => { const v = this.shownKey(); untracked(() => this.resetDetails()); void v; });
  }

  // ---------------------------------------------------------------- derived state

  shown = computed(() => { const r = this.rec(); return r ? r.draft ?? r.current : null; });
  shownKey = computed(() => { const v = this.shown(); return v ? `${v.recordId}:${v.versionNumber}:${v.state}` : ''; });
  data = computed(() => this.shown()?.data ?? null);
  editable = computed(() => { const r = this.rec(); return !!r?.draft && r.draft.state === 'draft'; });
  docs = computed<PinnedDocument[]>(() => this.data()?.documents ?? []);
  owners = computed<Owner[]>(() => this.data()?.owners ?? []);
  chain = computed(() => this.shown()?.derived?.chain ?? []);
  checks = computed<Check[]>(() => this.shown()?.checks ?? []);
  required = computed(() => this.checks().filter(c => c.level === 'error'));
  failing = computed(() => this.required().filter(c => !c.ok));
  passing = computed(() => this.required().filter(c => c.ok).length);
  isSubmitter = computed(() => this.rec()?.draft?.submittedById === this.auth.me()?.user.id);
  suggestedOwnersDiffer = computed(() => { const s = this.shown()?.derived?.owners; return !!s?.length && ownerKey(s) !== ownerKey(this.owners()); });
  suggestedOwnersText = computed(() => (this.shown()?.derived?.owners || []).map(o => `${o.name} ${o.share}`).join(', '));
  suggestedExtentDiffers = computed(() => { const s = this.shown()?.derived?.extent, e = this.data()?.extent; return !!s && (!e || s.value !== e.value || s.unit !== e.unit); });
  extentByHand = computed(() => {
    const f = this.df(), s = this.shown()?.derived?.extent, e = this.data()?.extent;
    const v = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (!f.extent || (e && e.value === v && e.unit === f.unit)) return false;
    return !s || s.value !== v || s.unit !== f.unit;
  });
  versionLabel = computed(() => {
    const r = this.rec(); if (!r) return '';
    if (r.draft) return `${r.draft.state === 'in_review' ? 'Version' : 'Draft version'} ${r.draft.versionNumber}${r.current ? ' · current is version ' + r.current.versionNumber : ''}`;
    return `Version ${r.currentVersion}`;
  });

  filters = computed(() => {
    const rows = this.records(), n = (f: SFilter) => rows.filter(r => this.matches(r, f)).length;
    return [
      { id: 'all' as SFilter, label: 'All', n: rows.length }, { id: 'draft' as SFilter, label: 'Draft', n: n('draft') },
      { id: 'in_review' as SFilter, label: 'In review', n: n('in_review') }, { id: 'committed' as SFilter, label: 'Committed', n: n('committed') },
      { id: 'needs_review' as SFilter, label: 'Needs review', n: n('needs_review') }
    ];
  });
  visible = computed(() => this.records().filter(r => this.matches(r, this.sf())));
  kindFields = computed(() => {
    const k = this.kinds().find(x => x.id === this.ckind()); if (!k) return [];
    const p = k.schema.properties.parcel;
    return Object.keys(p.properties).filter(f => f !== 'kind').map(f => ({ k: f, required: (p.required || []).includes(f) }));
  });
  canCreate = computed(() => this.cmode() === 'doc' ? !!this.cpick() : this.kindFields().filter(f => f.required).every(f => (this.cparcel()[f.k] || '').trim()));
  parcelKeys = computed(() => Object.keys(this.data()?.parcel || {}).filter(k => k !== 'kind' && this.data()!.parcel[k] !== null && this.data()!.parcel[k] !== ''));

  matches(r: RecordSummary, f: SFilter) {
    if (f === 'all') return true;
    if (f === 'draft') return r.status === 'draft';
    if (f === 'committed') return r.status === 'committed';
    if (f === 'in_review') return r.draftState === 'in_review';
    return r.needsReview;
  }
  statusOf(r: RecordSummary): { label: string; tag: string } {
    if (r.needsReview) return { label: 'Needs review', tag: 'tag-outline' };
    if (r.draftState === 'in_review') return { label: 'In review', tag: 'tag-info' };
    if (r.status === 'draft') return { label: 'Draft', tag: 'tag-neutral' };
    if (r.draftVersion) return { label: 'Change in progress', tag: 'tag-neutral' };
    return { label: 'Committed', tag: 'tag-accent' };
  }
  dot(r: RecordSummary) { return r.needsReview ? 'flag' : r.draftState === 'in_review' ? 'review' : r.status === 'committed' ? 'committed' : 'draft'; }
  typeLabel(id: string) { return this.docTypes().find(t => t.id === id)?.label || id.replace(/_/g, ' '); }
  parcelLabel(k: string) { return PARCEL_LABELS[k] || k; }
  tenureLabel(t?: string) { return t ? t[0].toUpperCase() + t.slice(1) : 'Tenure not set'; }
  extentText(e?: { value: number; unit: string } | null) { return e ? `${e.value.toLocaleString('en-ZA')} ${e.unit === 'm2' ? 'm²' : 'ha'}` : '—'; }
  initials(n: string) { return n.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase(); }
  linkedText(p: FoundDocument) { return p.linkedTo.map(l => `${l.label} (${l.recordNo})`).join(', '); }
  newer(d: PinnedDocument) { const f = this.rec()?.flags.find(x => x.edrmsDocumentId === d.edrmsDocumentId && x.to > d.version); return f ? f.to : null; }
  checkLabel(c: Check) {
    return ({ shares_sum: 'Shares add up to 1', chain_of_title: 'Chain of title', extent_vs_sg: 'Extent matches the SG diagram', id_numbers: 'ID numbers',
      parcel_match: 'Documents describe this parcel', documents_current: 'Documents are current', overrides: 'Values from the documents' } as Record<string, string>)[c.id] || c.id;
  }

  // ---------------------------------------------------------------- loading

  async loadList() {
    try {
      const { items } = await this.records$.list(this.q().trim() || undefined);
      this.records.set(items);
      if (!this.selId() && items.length) this.select(items[0].id);
    } catch (e) { this.fail('Could not load land records', e); }
    finally { this.loading.set(false); }
  }
  search(v: string) { this.q.set(v); this.debounce('list', () => this.loadList()); }

  async select(id: string) {
    this.selId.set(id);
    this.tab.set('documents'); this.dq.set(''); this.draftText.set(''); this.comments.set([]);
    try {
      const r = await this.records$.get(id);
      if (this.selId() !== id) return;             // another record was picked meanwhile
      this.rec.set(r);
      this.loadFound();
      this.loadComments();
    } catch (e) { this.fail('Could not open the land record', e); }
  }
  /** The record changed (an action, or someone else): show it, and its row in the list. */
  private show(r: LandRecord) {
    this.rec.set(r);
    const { current, draft, draftDiff, ...summary } = r;
    this.records.update(list => list.some(x => x.id === r.id) ? list.map(x => (x.id === r.id ? summary : x)) : [summary, ...list]);
  }
  private async reload() { const id = this.selId(); if (id) this.show(await this.records$.get(id)); }

  /** Run a change; a stale revision reloads the record, other errors are shown. */
  private async act(fn: (r: LandRecord) => Promise<LandRecord>, done?: string) {
    const r = this.rec(); if (!r || this.busy()) return null;
    this.busy.set(true);
    try {
      const updated = await fn(r);
      this.show(updated);
      if (done) this.toast.show('success', done);
      return updated;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { await this.reload().catch(() => {}); }
      this.fail(e instanceof ApiError && e.status === 409 ? 'Not saved' : 'Could not save', e);
      return null;
    } finally { this.busy.set(false); }
  }
  private fail(title: string, e: unknown) {
    const err = e instanceof ApiError ? e : null;
    const list = err?.details?.problems?.length ? ' ' + err.details.problems.join('; ') : '';
    this.toast.show('danger', title, (err?.message || String(e)) + list, 7000);
  }
  private debounce(key: string, fn: () => void, ms = 250) { clearTimeout(this.timers[key]); this.timers[key] = setTimeout(fn, ms); }

  // ---------------------------------------------------------------- documents

  setMode(m: 'match' | 'search') { this.mode.set(m); this.loadFound(); }
  searchDocs(v: string) { this.dq.set(v); this.debounce('docs', () => this.loadFound()); }
  async loadFound() {
    const r = this.rec(); if (!r || !this.editable()) { this.found.set([]); return; }
    this.finding.set(true);
    try {
      if (this.mode() === 'match') this.found.set((await this.records$.suggestions(r.id)).items);
      else this.found.set(this.dq().trim() ? (await this.records$.searchDocuments(this.dq().trim(), r.id)).items : []);
    } catch (e) { this.found.set([]); this.fail('Could not search the EDRMS', e); }
    finally { this.finding.set(false); }
  }
  async add(p: FoundDocument) {
    if (await this.act(r => this.records$.link(r.id, r.draft!.revision, p.edrmsDocumentId), `${p.ref || p.edrmsNo} added to ${this.rec()!.label}`)) this.loadFound();
  }
  async remove(d: PinnedDocument) {
    const r = this.rec()!;
    if (!(await this.confirm.ask({ title: `Remove ${d.ref || d.edrmsNo} from ${r.label}?`, body: 'The document stays in the EDRMS. Owners and checks are recalculated.', confirmLabel: 'Remove document', tone: 'danger' }))) return;
    if (await this.act(x => this.records$.unlink(x.id, x.draft!.revision, d.edrmsDocumentId), `${d.ref || d.edrmsNo} removed`)) this.loadFound();
  }
  refresh(d: PinnedDocument) { return this.act(r => this.records$.refresh(r.id, r.draft!.revision, d.edrmsDocumentId), `${d.ref || d.edrmsNo} updated to the newer version`); }
  async view(edrmsDocumentId: string, version?: number) {
    try { window.open((await this.records$.contentLink(edrmsDocumentId, version)).url, '_blank', 'noopener'); }
    catch (e) { this.fail('Could not open the document', e); }
  }
  viewByNo(edrmsNo: string) { const d = this.docs().find(x => x.edrmsNo === edrmsNo); if (d) this.view(d.edrmsDocumentId, d.version); }

  // ---------------------------------------------------------------- owners, extent, details

  async accept(field: 'owners' | 'extent') {
    const done = await this.act(r => this.records$.edit(r.id, { revision: r.draft!.revision, accept: [field] }), field === 'owners' ? 'Owners taken from the documents' : 'Extent taken from the documents');
    if (done && field === 'extent') this.df.update(f => ({ ...f, extent: String(done.draft?.data.extent?.value ?? ''), unit: done.draft?.data.extent?.unit ?? 'm2', reason: '' }));
  }
  editOwners() { this.ownerForm.set({ owners: structuredClone(this.owners().length ? this.owners() : this.shown()?.derived?.owners ?? []), reason: '' }); }
  setOwner(i: number, k: 'name' | 'idNo' | 'share', v: string) { this.ownerForm.update(f => f && ({ ...f, owners: f.owners.map((o, j) => (j === i ? { ...o, [k]: v } : o)) })); }
  addOwner() { this.ownerForm.update(f => f && ({ ...f, owners: [...f.owners, { name: '', share: '' }] })); }
  removeOwner(i: number) { this.ownerForm.update(f => f && ({ ...f, owners: f.owners.filter((_, j) => j !== i) })); }
  setOwnerReason(v: string) { this.ownerForm.update(f => f && ({ ...f, reason: v })); }
  async saveOwners() {
    const f = this.ownerForm()!;
    const owners = f.owners.filter(o => o.name.trim()).map(o => ({ ...o, name: o.name.trim(), share: o.share.trim(), ...(o.idNo?.trim() ? { idNo: o.idNo.trim() } : { idNo: undefined }) }))
      .map(({ idNo, ...o }) => (idNo ? { ...o, idNo } : o));
    if (await this.act(r => this.records$.edit(r.id, { revision: r.draft!.revision, changes: { owners }, ...(f.reason.trim() ? { reason: f.reason.trim() } : {}) }), 'Owners saved')) this.ownerForm.set(null);
  }

  resetDetails() {
    const d = this.data();
    this.df.set({
      tenure: d?.tenure ?? '', extent: d?.extent ? String(d.extent.value) : '', unit: d?.extent?.unit ?? 'm2', reason: '',
      encumbrances: structuredClone(d?.encumbrances ?? []),
      attributes: Object.entries(d?.attributes ?? {}).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v), orig: v }))
    });
  }
  setDf(k: string, v: string) { this.df.update(f => ({ ...f, [k]: v })); }
  setEnc(i: number, k: string, v: string) { this.df.update(f => ({ ...f, encumbrances: f.encumbrances.map((e, j) => (j === i ? { ...e, [k]: v } : e)) })); }
  addEnc() { this.df.update(f => ({ ...f, encumbrances: [...f.encumbrances, { type: 'servitude', ref: '' }] })); }
  removeEnc(i: number) { this.df.update(f => ({ ...f, encumbrances: f.encumbrances.filter((_, j) => j !== i) })); }
  setAttr(i: number, k: 'k' | 'v', v: string) { this.df.update(f => ({ ...f, attributes: f.attributes.map((a, j) => (j === i ? { ...a, [k]: v } : a)) })); }
  addAttr() { this.df.update(f => ({ ...f, attributes: [...f.attributes, { k: '', v: '' }] })); }
  removeAttr(i: number) { this.df.update(f => ({ ...f, attributes: f.attributes.filter((_, j) => j !== i) })); }
  async saveDetails() {
    const f = this.df(), d = this.data()!;
    const changes: Record<string, any> = {};
    if ((f.tenure || null) !== (d.tenure ?? null)) changes['tenure'] = f.tenure || null;
    const value = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (f.extent && (!d.extent || d.extent.value !== value || d.extent.unit !== f.unit)) changes['extent'] = { value, unit: f.unit };
    if (!f.extent && d.extent) changes['extent'] = null;
    const enc = f.encumbrances.filter(e => (e.ref || '').trim()).map(e => ({ type: e.type, ref: e.ref.trim(), ...(e.inFavourOf?.trim() ? { inFavourOf: e.inFavourOf.trim() } : {}), ...(e.note ? { note: e.note } : {}) }));
    if (JSON.stringify(enc) !== JSON.stringify(d.encumbrances ?? [])) changes['encumbrances'] = enc;
    // a value shown as JSON and left unchanged keeps its type (number, list, object)
    const attributes = Object.fromEntries(f.attributes.filter(a => a.k.trim()).map(a => [a.k.trim(), a.orig !== undefined && typeof a.orig !== 'string' && a.v === JSON.stringify(a.orig) ? a.orig : a.v]));
    if (JSON.stringify(attributes) !== JSON.stringify(d.attributes ?? {})) changes['attributes'] = Object.keys(attributes).length ? attributes : null;
    if (!Object.keys(changes).length) { this.toast.show('info', 'Nothing to save'); return; }
    if (await this.act(r => this.records$.edit(r.id, { revision: r.draft!.revision, changes, ...(f.reason.trim() ? { reason: f.reason.trim() } : {}) }), 'Details saved')) this.resetDetails();
  }

  // ---------------------------------------------------------------- lifecycle

  async submit() {
    const r = this.rec()!;
    const owners = this.owners().map(o => `${o.name} ${o.share}`).join(', ') || 'none';
    if (!(await this.confirm.ask({ title: `Submit ${r.label} for review?`, body: `Owners: ${owners}. A second person who can finalize records approves or returns it. It cannot be edited while in review.`, confirmLabel: 'Submit for review' }))) return;
    await this.act(x => this.records$.submit(x.id, x.draft!.revision), `${r.label} submitted for review`);
  }
  async withdraw() {
    const r = this.rec()!;
    if (!(await this.confirm.ask({ title: `Withdraw ${r.label} from review?`, body: 'The approval task is removed and the draft can be edited again.', confirmLabel: 'Withdraw' }))) return;
    if (await this.act(x => this.records$.withdraw(x.id), 'Withdrawn from review')) this.loadFound();
  }
  async change() {
    if (await this.act(r => this.records$.openDraft(r.id), 'A new draft is open; the committed version stays current until the change is approved')) { this.addOpen.set(true); this.loadFound(); }
  }

  // ---------------------------------------------------------------- comments

  async loadComments() {
    const id = this.selId(); if (!id) return;
    try { this.comments.set((await this.records$.comments(id)).items); } catch { /* shown as empty */ }
  }
  async post() {
    const t = this.draftText().trim(), id = this.selId();
    if (!t || !id || !this.rbac.can('record.comment')) return;
    try { const c = await this.records$.comment(id, t); this.comments.update(l => [...l, c]); this.draftText.set(''); }
    catch (e) { this.fail('Could not post the comment', e); }
  }

  // ---------------------------------------------------------------- new record

  openCreate() {
    this.cmode.set('doc'); this.cq.set(''); this.cfound.set([]); this.cpick.set(null); this.cparcel.set({});
    if (!this.kinds().length) this.records$.catalogue().then(c => this.kinds.set(c.parcelKinds)).catch(e => this.fail('Could not load parcel kinds', e));
    this.createOpen.set(true);
  }
  searchCreate(v: string) {
    this.cq.set(v);
    this.debounce('create', async () => {
      try { this.cfound.set(this.cq().trim() ? (await this.records$.searchDocuments(this.cq().trim())).items : []); } catch (e) { this.fail('Could not search the EDRMS', e); }
    });
  }
  setParcel(k: string, v: string) { this.cparcel.update(p => ({ ...p, [k]: v })); }
  async create() {
    if (!this.canCreate() || this.busy()) return;
    this.busy.set(true);
    try {
      let body: { parcel?: any; edrmsDocumentId?: string };
      if (this.cmode() === 'doc') body = { edrmsDocumentId: this.cpick()! };
      else {
        const parcel: Record<string, any> = { kind: this.ckind() };
        for (const f of this.kindFields()) { const v = (this.cparcel()[f.k] || '').trim(); if (v) parcel[f.k] = f.k === 'participationQuota' ? Number(v) : v; }
        body = { parcel };
      }
      const r = await this.records$.create(body);
      this.createOpen.set(false); this.sf.set('all');
      this.show(r); this.selId.set(r.id); this.tab.set('documents'); this.mode.set('match'); this.addOpen.set(true); this.loadFound(); this.comments.set([]);
      this.router.navigate([], { queryParams: { record: r.id }, replaceUrl: true });
      this.toast.show('success', `${r.label} created`, r.recordNo);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409 && err.details?.recordId) { this.createOpen.set(false); this.select(err.details.recordId); }
      this.fail('Could not create the record', e);
    } finally { this.busy.set(false); }
  }
}
