import type { RecordTab } from '@/features/record/tabContract';
import type { TabPersistenceCodec } from '@/tab-workspace/contracts';

export interface PersistedRecordTab {
  view: 'record';
  id: string;
  recordId: string;
  title: string;
}

export const recordTabPersistenceCodec: TabPersistenceCodec<RecordTab, PersistedRecordTab> = {
  serialize: (tab) =>
    tab.recordId.length > 0
      ? {
          view: 'record',
          id: tab.id,
          recordId: tab.recordId,
          title: tab.title,
        }
      : null,
  parse: (value) => {
    if (typeof value !== 'object' || value === null) return null;
    const tab = value as Record<string, unknown>;
    return tab.view === 'record' &&
      typeof tab.id === 'string' &&
      tab.id.length > 0 &&
      typeof tab.recordId === 'string' &&
      tab.recordId.length > 0 &&
      typeof tab.title === 'string'
      ? {
          view: 'record',
          id: tab.id,
          recordId: tab.recordId,
          title: tab.title,
        }
      : null;
  },
  hydrate: (tab) => ({ ...tab }),
  resourceIdentity: (tab) => `record:${tab.recordId}`,
};
