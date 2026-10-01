import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../api/api.service';
import { AuthService } from './auth.service';

/** An inbox entry from GET /api/tasks. */
export interface TaskItem {
  id: string; instanceId: string; nodeId: string; definitionKey: string; businessKey: string | null; title: string;
  status: 'created' | 'claimed'; createdAt: string; dueAt: string | null; overdue: boolean;
  claimedById: string | null; claimedByName: string | null; outcomes: string[] | null;
  document?: { id: string; edrmsNo: string; title: string; instrumentRef: string | null; currentVersion: number };
}
/** GET /api/tasks/:id — the task with the process variables it was created with. */
export interface TaskDetail extends TaskItem {
  input: {
    reason?: string; startedBy?: { id: string; name: string }; expectedVersion?: number;
    preview?: { k: string; label: string; from: string; to: string }[];
    document?: TaskItem['document'];
    [k: string]: any;
  };
}

const POLL_MS = 60_000;

/** The signed-in user's workflow inbox (bpm): open tasks they may do plus tasks they claimed. */
@Injectable({ providedIn: 'root' })
export class TasksService {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  readonly tasks = signal<TaskItem[]>([]);
  private timer: any;

  constructor() {
    effect(() => {
      const signedIn = this.auth.signedIn();
      untracked(() => {
        clearInterval(this.timer);
        if (!signedIn) { this.tasks.set([]); return; }
        this.refresh();
        this.timer = setInterval(() => this.refresh(), POLL_MS);
      });
    });
  }

  async refresh() {
    try {
      this.tasks.set((await this.api.get<{ tasks: TaskItem[] }>('/tasks')).tasks);
    } catch { /* keep the last list; the bell is not worth an error toast */ }
  }

  get(id: string) { return this.api.get<TaskDetail>(`/tasks/${id}`); }

  async complete(id: string, outcome: string, comment?: string) {
    const res = await this.api.post<{ instance: { status: string; outcome: string | null; errorMessage?: string } }>(`/tasks/${id}/complete`, { output: { outcome, ...(comment ? { comment } : {}) } });
    await this.refresh();
    return res.instance;
  }
}
