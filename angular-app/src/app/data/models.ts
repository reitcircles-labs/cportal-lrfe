export type FieldStatus = 'pending' | 'accepted' | 'edited';
export type LinkState = 'base' | 'linked' | 'suggested' | 'pending' | 'rejected';
export type ViewerCtx = 'batch' | 'record' | 'audit';

export interface DocField { k: string; label: string; v: string; c?: number; }

export interface LandDoc {
  id: string; ref: string; title: string; type: string; pages: number; cls: number; edrms: string;
  iso?: string; header: string; sigL?: string; sigR?: string; qc: string;
  isDiagram?: boolean; isBase?: boolean; batch?: string;
  fields: DocField[]; paras: string[][];
  preFiled?: boolean; preReviewed?: number; assignee?: string | null;
}

export interface Batch { id: string; src: string; n?: number; mode?: 'todo' | 'mixed' | 'filed'; }
export interface Candidate { name: string; meta: string; score: number; r: ['ok' | 'warn' | 'no', string][]; }
export interface ChainEntry { id: string; iso: string; ref: string; type: string; edrms: string; summary: string; }
export interface AuditEntry { n: number; who: string; role: string; action: string; obj: string; detail: string; }
export interface FieldEdit { value?: string; status?: FieldStatus; }
