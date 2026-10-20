import {Injectable, computed, inject} from '@angular/core';
import {RecordsApi} from '../../api/records.api';
import {isDecision, groupByVersion} from './discussion';
import {DFilter, LinkStore} from './link.store';

/** Land record, Discussion tab: the comments and decisions by version, filtered, and posting a comment. */
@Injectable()
export class LinkDiscussion {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);

  dfilters = computed(() => {
    const all = this.store.events();
    const decisions = all.filter(isDecision).length;
    return [
      {id: 'all' as DFilter, label: 'All', n: all.length},
      {id: 'comments' as DFilter, label: 'Comments', n: all.length - decisions},
      {id: 'decisions' as DFilter, label: 'Decisions', n: decisions},
    ];
  });

  groups = computed(() => {
    const f = this.store.dfilter();
    return groupByVersion(
      this.store
        .events()
        .filter(e => f === 'all' || (f === 'decisions') === isDecision(e)),
    );
  });

  async post() {
    const t = this.store.draftText().trim();
    const id = this.store.selId();
    if (!t || !id || !this.store.rbac.can('record.comment')) return;
    try {
      const c = await this.records$.comment(id, t);
      this.store.comments.update(l => [...l, c]);
      this.store.draftText.set('');
    } catch (e) {
      this.store.fail('Could not post the comment', e);
    }
  }

  // ---------------------------------------------------------------- review & approve
}
