import {Injectable, inject} from '@angular/core';
import {FoundDocument, PinnedDocument, RecordsApi} from '../../api/records.api';
import {ConfirmService} from '../../state/confirm.service';
import {LinkStore} from './link.store';

/** Land record, Documents tab: finding filed documents and adding, removing, updating and opening them. */
@Injectable()
export class LinkDocumentsSearch {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);
  private confirm = inject(ConfirmService);

  newer(d: PinnedDocument) {
    const f = this.store
      .rec()
      ?.flags.find(
        x =>
          x.type === 'document_updated' &&
          x.edrmsDocumentId === d.edrmsDocumentId &&
          (x.to ?? 0) > d.version,
      );
    return f?.to ?? null;
  }

  setMode(m: 'match' | 'search') {
    this.store.mode.set(m);
    this.store.loadFound();
  }

  searchDocs(v: string) {
    this.store.dq.set(v);
    this.store.debounce('docs', () => this.store.loadFound());
  }

  async add(p: FoundDocument) {
    if (
      await this.store.act(
        r => this.records$.link(r.id, r.draft!.revision, p.edrmsDocumentId),
        `${p.ref || p.edrmsNo} added to ${this.store.rec()!.label}`,
      )
    ) {
      this.store.loadFound();
    }
  }

  async remove(d: PinnedDocument) {
    const r = this.store.rec()!;
    if (
      !(await this.confirm.ask({
        title: `Remove ${d.ref || d.edrmsNo} from ${r.label}?`,
        body: 'The document stays in the EDRMS. Owners and checks are recalculated.',
        confirmLabel: 'Remove document',
        tone: 'danger',
      }))
    ) {
      return;
    }
    if (
      await this.store.act(
        x => this.records$.unlink(x.id, x.draft!.revision, d.edrmsDocumentId),
        `${d.ref || d.edrmsNo} removed`,
      )
    ) {
      this.store.loadFound();
    }
  }

  refresh(d: PinnedDocument) {
    return this.store.act(
      r => this.records$.refresh(r.id, r.draft!.revision, d.edrmsDocumentId),
      `${d.ref || d.edrmsNo} updated to the newer version`,
    );
  }

  async view(edrmsDocumentId: string, version?: number) {
    try {
      window.open(
        (await this.records$.contentLink(edrmsDocumentId, version)).url,
        '_blank',
        'noopener',
      );
    } catch (e) {
      this.store.fail('Could not open the document', e);
    }
  }

  viewByNo(edrmsNo: string) {
    const d = this.store.docs().find(x => x.edrmsNo === edrmsNo);
    if (d) this.view(d.edrmsDocumentId, d.version);
  }

  // ---------------------------------------------------------------- owners, extent, details
}
