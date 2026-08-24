// ThoughtPanel — left column of Task Center: Thought stream.
// Owns its own section header (icon + label + search toggle) so the search
// box is collapsed by default and matches the "最近历史" / "工作区文件管理"
// interaction pattern.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotebookPen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  thoughtList,
  thoughtMerge,
  thoughtDelete,
  thoughtSetArchived,
  recordDelete,
  recordList,
  recordSetArchived,
  taskCenterAvailable,
} from '@/api/taskCenter';
import { SearchPill } from './SearchPill';
import { ThoughtInput } from './ThoughtInput';
import { ThoughtCard } from './ThoughtCard';
import { AudioRecordCard } from './AudioRecordCard';
import { ThoughtBulkBar } from './ThoughtBulkBar';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { listenWithCleanup } from '@/utils/tauriListen';
import { searchRecords, type RecordSearchHit } from '@/api/searchClient';
// `projects` (not `config.agents`) feeds the # picker — see
// useThoughtTagCandidates for the rationale.
import { useThoughtTagCandidates } from '@/hooks/useThoughtTagCandidates';
import type { Thought } from '@/../shared/types/thought';
import type { RecordChange, RecordSummary } from '@/../shared/types/record';

interface Props {
  onDispatchThought?: (t: Thought) => void;
  onDiscussThought?: (t: Thought, workspaceId: string) => void;
  /**
   * When `true`, the panel re-fetches from disk. Parent should bump this on tab
   * activation so a thought created elsewhere (e.g. Launcher 想法 mode) appears
   * without requiring manual reload.
   */
  refreshKey?: unknown;
  /**
   * When `true`, the ThoughtInput auto-focuses its textarea. Parent (TaskCenter)
   * threads `isActive` through this so returning to the tab drops the caret
   * into the input box without a second click (v0.1.69 UX round).
   */
  autoFocusInput?: boolean;
  onOpenRecord?: (recordId: string, mediaMs?: number) => void;
}

export function ThoughtPanel({
  onDispatchThought,
  onDiscussThought,
  refreshKey,
  autoFocusInput = false,
  onOpenRecord,
}: Props) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [audioRecords, setAudioRecords] = useState<RecordSummary[]>([]);
  const [kindFilter, setKindFilter] = useState<'all' | 'text' | 'audio'>('all');
  const [query, setQuery] = useState('');
  const [recordSearchHits, setRecordSearchHits] = useState<Map<
    string,
    RecordSearchHit
  > | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // v0.2.16: archive view filter. Default 'active' — archived thoughts
  // are soft-hidden from the panel until the user flips this toggle.
  const [viewMode, setViewMode] = useState<'active' | 'archived'>('active');
  // `searchFocused` opens the tag-cloud panel below the search pill when
  // the user has focused the input without typing anything yet — gives
  // them a shortcut to "oh, pick a tag" vs. "type a search". Set on
  // focus, cleared on blur; the blur is delayed by a frame so clicking
  // a cloud tag doesn't get swallowed.
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Multi-select mode (PRD 0.2.4 §需求 2). `selectMode` flips the entire
  // panel into a bulk-action surface; `selectedIds` holds the membership
  // set. Both reset when the user changes the active tag / query so a
  // selected row that filters out doesn't become a phantom selection.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [audioDeleteTarget, setAudioDeleteTarget] =
    useState<RecordSummary | null>(null);
  const toast = useToast();
  const { t } = useTranslation('task');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, audio] = await Promise.all([
        thoughtList({ archived: viewMode }),
        recordList({ kind: 'audio', archived: viewMode }),
      ]);
      setThoughts(list);
      setAudioRecords(audio);
      // Drop any phantom ids from the current selection — a thought that
      // was selected before reload but no longer exists (e.g. deleted in
      // another window, or merged elsewhere) shouldn't keep counting
      // toward the bulk-action header. handleCardChanged covers in-panel
      // deletes; this catches external mutations.
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const valid = new Set([
          ...list.map((t) => t.id),
          ...audio.map((record) => record.id),
        ]);
        let changed = false;
        const next = new Set<string>();
        for (const id of prev) {
          if (valid.has(id)) next.add(id);
          else changed = true;
        }
        return changed ? next : prev;
      });
    } catch (err) {
      console.error('[ThoughtPanel] load failed', err);
      setThoughts([]);
      setAudioRecords([]);
    } finally {
      setLoading(false);
    }
  }, [viewMode]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setRecordSearchHits(null);
      return;
    }
    let cancelled = false;
    setRecordSearchHits(null);
    void searchRecords(needle, 200)
      .then((result) => {
        if (cancelled) return;
        const hits = new Map<string, RecordSearchHit>();
        for (const hit of result.hits) {
          if (!hits.has(hit.recordId)) hits.set(hit.recordId, hit);
        }
        setRecordSearchHits(hits);
      })
      .catch((error) => {
        console.warn(
          '[ThoughtPanel] Record search unavailable; using metadata fallback',
          error,
        );
        if (!cancelled) setRecordSearchHits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // When a task transitions (including creation → convertedTaskIds backlink on
  // its source thought), refetch so "已派生 N 个任务" count stays live.
  useEffect(() => {
    if (!taskCenterAvailable()) return;
    const ac = new AbortController();
    void listenWithCleanup(
      'task:status-changed',
      () => {
        void reload();
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [reload]);

  useEffect(() => {
    if (!taskCenterAvailable()) return;
    const ac = new AbortController();
    void listenWithCleanup<RecordChange>(
      'record:changed',
      () => {
        void reload();
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [reload]);

  const handleCardChanged = useCallback(
    (prevId: string, next: Thought | null) => {
      if (next === null) {
        setThoughts((prev) => prev.filter((x) => x.id !== prevId));
        setSelectedIds((s) => {
          if (!s.has(prevId)) return s;
          const ns = new Set(s);
          ns.delete(prevId);
          return ns;
        });
        return;
      }
      // If the card's new archived state no longer matches the panel's
      // view mode (e.g. user just archived a card while looking at
      // active list), drop it from the current view rather than leaving
      // a stale row behind. Search / merge / unrelated edits don't trip
      // this — only archive/unarchive does.
      const fitsView =
        viewMode === 'archived'
          ? next.archived === true
          : next.archived !== true;
      if (!fitsView) {
        setThoughts((prev) => prev.filter((x) => x.id !== prevId));
        setSelectedIds((s) => {
          if (!s.has(prevId)) return s;
          const ns = new Set(s);
          ns.delete(prevId);
          return ns;
        });
        return;
      }
      setThoughts((prev) => prev.map((x) => (x.id === prevId ? next : x)));
    },
    [viewMode],
  );

  const enterSelectMode = useCallback((seedId?: string) => {
    setSelectMode(true);
    if (seedId) setSelectedIds(new Set([seedId]));
    else setSelectedIds(new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Esc key exits select mode (matches the panel's other "close current
  // mode" affordances). Listener only attaches while in select mode so
  // we don't compete with other Escape consumers (e.g. open dialogs).
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDeleteOpen) {
        e.stopPropagation();
        exitSelectMode();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectMode, confirmDeleteOpen, exitSelectMode]);

  // Resetting selection on filter change avoids "I selected 5 thoughts
  // then switched to #维护 and now my action bar says '5 selected' but
  // I only see 2 cards" — a confusing state that's hard to recover from.
  // The ref guards against firing on the initial render after entering
  // select mode (which would wipe the seed thought passed by the ⋯ menu).
  const filterSnapshotRef = useRef({
    tag: activeTag,
    q: query,
    kind: kindFilter,
  });
  useEffect(() => {
    if (!selectMode) {
      filterSnapshotRef.current = {
        tag: activeTag,
        q: query,
        kind: kindFilter,
      };
      return;
    }
    const prev = filterSnapshotRef.current;
    if (
      prev.tag !== activeTag ||
      prev.q !== query ||
      prev.kind !== kindFilter
    ) {
      filterSnapshotRef.current = {
        tag: activeTag,
        q: query,
        kind: kindFilter,
      };
      setSelectedIds(new Set());
    }
  }, [activeTag, kindFilter, query, selectMode]);

  // History-only tag list — drives the search-box tag cloud below, which is
  // an inventory of tags the user has *actually used*. Including agent names
  // here would make the cloud show phantom tags that filter nothing.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of thoughts) {
      for (const tag of t.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    for (const record of audioRecords) {
      for (const tag of record.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [audioRecords, thoughts]);

  // Picker candidates — history tags + user-visible workspace names
  // (sanitized to pass the Rust `#` parser). Workspace names surface as
  // default options even when no thought has used them yet, so a brand-
  // new workspace is discoverable the first time the user presses `#`.
  // Uses `projects` (what the Launcher actually shows) rather than
  // `config.agents` so the candidate list matches the visible workspace
  // inventory 1:1 — including plain workspaces not yet upgraded to
  // Agents, and excluding internal workspaces like `~/.myagents`.
  const { projects } = useConfig();
  const tagCandidates = useThoughtTagCandidates(thoughts, projects);

  // Search panel shows the tag cloud only when the user has focused the
  // search input AND hasn't narrowed by text or picked a tag yet. Typing
  // text or selecting a tag collapses the cloud (animated) so the result
  // list takes over.
  const showTagCloud =
    searchFocused &&
    query.trim() === '' &&
    activeTag === null &&
    allTags.length > 0;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return thoughts.filter((t) => {
      if (activeTag && !t.tags.some((x) => x === activeTag)) return false;
      if (needle && !t.content.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [thoughts, query, activeTag]);

  const filteredAudio = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return audioRecords.filter((record) => {
      if (activeTag && !record.tags.some((tag) => tag === activeTag))
        return false;
      if (
        needle &&
        !recordSearchHits?.has(record.id) &&
        !record.title.toLowerCase().includes(needle) &&
        !record.tags.some((tag) => tag.toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
  }, [activeTag, audioRecords, query, recordSearchHits]);

  const visibleItems = useMemo(() => {
    const textItems =
      kindFilter === 'audio'
        ? []
        : filtered.map((thought) => ({
            kind: 'text' as const,
            updatedAt: thought.updatedAt,
            thought,
          }));
    const audioItems =
      kindFilter === 'text'
        ? []
        : filteredAudio.map((record) => ({
            kind: 'audio' as const,
            updatedAt: record.updatedAt,
            record,
          }));
    return [...textItems, ...audioItems].sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        (right.kind === 'audio'
          ? right.record.id
          : right.thought.id
        ).localeCompare(
          left.kind === 'audio' ? left.record.id : left.thought.id,
        ),
    );
  }, [filtered, filteredAudio, kindFilter]);

  const audioIdSet = useMemo(
    () => new Set(audioRecords.map((record) => record.id)),
    [audioRecords],
  );
  const selectionContainsAudio = useMemo(
    () => Array.from(selectedIds).some((id) => audioIdSet.has(id)),
    [audioIdSet, selectedIds],
  );

  const clearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.blur();
  }, []);

  const handleMerge = useCallback(async () => {
    if (bulkBusy) return;
    if (selectionContainsAudio) {
      toast.error(t('thoughts.mergeAudioUnsupported'));
      return;
    }
    // Walk the filtered list in display order and pick out selected ids.
    // This makes "merge follows top-to-bottom display order" robust to
    // tag filters and search queries — what the user sees is what gets
    // merged.
    const orderedIds = filtered
      .filter((t) => selectedIds.has(t.id))
      .map((t) => t.id);
    if (orderedIds.length < 2) {
      toast.error(t('thoughts.selectAtLeastTwo'));
      return;
    }
    setBulkBusy(true);
    try {
      const result = await thoughtMerge(orderedIds);
      const { merged, failedSourceDeletes } = result;
      // Drop only the sources that backend successfully removed; surface
      // the rest so the panel still shows them and the user can retry.
      const failedIds = new Set(failedSourceDeletes.map((f) => f.id));
      const successfullyDeletedIds = orderedIds.filter(
        (id) => !failedIds.has(id),
      );
      setThoughts((prev) => {
        const dropped = prev.filter(
          (t) => !successfullyDeletedIds.includes(t.id),
        );
        return [merged, ...dropped];
      });
      setSelectedIds(new Set());
      setSelectMode(false);
      if (failedSourceDeletes.length === 0) {
        toast.success(t('thoughts.merged', { count: orderedIds.length }));
      } else {
        toast.error(
          t('thoughts.mergePartial', { count: failedSourceDeletes.length }),
        );
      }
    } catch (e) {
      // Pre-flight or atomic-create failure — no source touched, no merge.
      toast.error(
        t('thoughts.mergeFailed', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, selectedIds, toast, filtered, selectionContainsAudio, t]);

  // Bulk archive / unarchive — flips every selected thought to the
  // opposite of the current view mode (active view → archive; archived
  // view → unarchive). Like handleBulkDelete, runs in parallel; we collect
  // failures so a single bad write doesn't strand the rest. v0.2.16.
  const handleBulkArchive = useCallback(async () => {
    if (bulkBusy) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const targetArchived = viewMode !== 'archived';
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          audioIdSet.has(id)
            ? recordSetArchived(id, targetArchived)
            : thoughtSetArchived(id, targetArchived),
        ),
      );
      let failures = 0;
      const succeeded: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') succeeded.push(ids[i]);
        else failures += 1;
      });
      // Drop succeeded rows from the current view — they now belong to
      // the opposite view mode.
      if (succeeded.length > 0) {
        setThoughts((prev) => prev.filter((t) => !succeeded.includes(t.id)));
        setAudioRecords((prev) =>
          prev.filter((record) => !succeeded.includes(record.id)),
        );
      }
      setSelectedIds(new Set());
      setSelectMode(false);
      if (failures === 0) {
        toast.success(
          t(
            targetArchived
              ? 'thoughts.archiveSuccess'
              : 'thoughts.unarchiveSuccess',
            { count: succeeded.length },
          ),
        );
      } else if (succeeded.length === 0) {
        toast.error(
          t(
            targetArchived
              ? 'thoughts.archiveFailed'
              : 'thoughts.unarchiveFailed',
          ),
        );
      } else {
        toast.error(
          t(
            targetArchived
              ? 'thoughts.archivePartial'
              : 'thoughts.unarchivePartial',
            { successCount: succeeded.length, failCount: failures },
          ),
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }, [audioIdSet, bulkBusy, selectedIds, viewMode, toast, t]);

  const handleBulkDelete = useCallback(async () => {
    if (bulkBusy) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      let failures = 0;
      // Run deletes in parallel — thought.delete is idempotent and
      // independent across ids; serial would just be slower with no
      // additional safety.
      const results = await Promise.allSettled(
        ids.map((id) =>
          audioIdSet.has(id) ? recordDelete(id) : thoughtDelete(id),
        ),
      );
      for (const r of results) if (r.status === 'rejected') failures += 1;
      const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
      if (succeeded.length > 0) {
        setThoughts((prev) => prev.filter((t) => !succeeded.includes(t.id)));
        setAudioRecords((prev) =>
          prev.filter((record) => !succeeded.includes(record.id)),
        );
      }
      setConfirmDeleteOpen(false);
      setSelectedIds(new Set());
      setSelectMode(false);
      if (failures === 0) {
        toast.success(t('thoughts.deleteSuccess', { count: succeeded.length }));
      } else if (succeeded.length === 0) {
        toast.error(t('thoughts.deleteFailed'));
      } else {
        toast.error(
          t('thoughts.deletePartial', {
            successCount: succeeded.length,
            failCount: failures,
          }),
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }, [audioIdSet, bulkBusy, selectedIds, toast, t]);

  const handleAudioArchive = useCallback(
    async (id: string, archived: boolean) => {
      try {
        await recordSetArchived(id, archived);
        setAudioRecords((current) =>
          current.filter((record) => record.id !== id),
        );
        toast.success(
          t(archived ? 'records.archiveSuccess' : 'records.unarchiveSuccess'),
        );
      } catch (error) {
        toast.error(
          t('records.mutationFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    [t, toast],
  );

  const handleAudioDelete = useCallback(async () => {
    const target = audioDeleteTarget;
    if (!target) return;
    try {
      await recordDelete(target.id);
      setAudioRecords((current) =>
        current.filter((record) => record.id !== target.id),
      );
      setAudioDeleteTarget(null);
      toast.success(t('records.deleteSuccess'));
    } catch (error) {
      toast.error(
        t('records.mutationFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [audioDeleteTarget, t, toast]);

  return (
    <div className="relative flex h-full flex-col">
      {/* Section header — label on the left, persistent search pill on
          the right. The search pill replaces the prior "icon toggle →
          full-width input" pattern with an always-visible affordance
          per the reference mock. Tag-cloud dropdown is re-attached
          relative to this header's container so it still appears right
          under the search input, via absolute positioning. */}
      {/* Panel header — v0.1.69 polish: hairline below removed;
          the gap between this row and the content below is now
          pure breathing room (via the input row's own padding) so
          the column reads as one continuous surface. Vertical
          divider between the two panels remains (handled in
          TaskCenter.tsx). */}
      <div className="relative flex h-12 shrink-0 items-center px-4">
        {/* When the search pill is active (focused or has a query), the
            "想法" label folds out of the row so the input can claim the
            full width. We keep the label in the DOM with width:0 +
            opacity so there's no reflow flash; the SearchPill owns the
            animation via its own width transition. */}
        {(() => {
          const searchActive = searchFocused || query.length > 0;
          return (
            <>
              <div
                className="flex items-center gap-2 overflow-hidden"
                style={{
                  maxWidth: searchActive ? '0px' : '120px',
                  opacity: searchActive ? 0 : 1,
                  marginRight: searchActive ? '0' : '8px',
                  transition:
                    'max-width 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease-out, margin-right 200ms cubic-bezier(0.22, 1, 0.36, 1)',
                  pointerEvents: searchActive ? 'none' : 'auto',
                }}
              >
                {/* `relative top-[1px]` nudges the icon down ~1px so its
                    optical center aligns with the Chinese label's ink
                    center — lucide icons are geometrically centered in
                    their viewBox but Chinese glyphs sit slightly below
                    the em box center, making items-center alone read as
                    icon-too-high. Same tweak on TaskListPanel's CheckSquare. */}
                <NotebookPen
                  className="relative top-[1px] h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                  strokeWidth={1.5}
                />
                <span className="whitespace-nowrap text-base font-semibold text-[var(--ink)]">
                  {t('records.title')}
                </span>
              </div>
              <div className="ml-auto flex min-w-0 flex-1 justify-end">
                <SearchPill
                  inputRef={searchInputRef}
                  value={query}
                  onChange={setQuery}
                  onClear={clearSearch}
                  placeholder={t('records.searchPlaceholder')}
                  expandedFull
                  onFocus={() => setSearchFocused(true)}
                  // Delay blur so clicking a tag inside the floating cloud
                  // registers before the cloud collapses. The tag buttons use
                  // `onMouseDown` + preventDefault to re-focus the input, but
                  // that sequence still triggers a blur→focus round-trip —
                  // the 120ms grace absorbs it cleanly.
                  onBlur={() => setTimeout(() => setSearchFocused(false), 120)}
                />
              </div>
            </>
          );
        })()}

        {/* Tag cloud — floats under the search pill when focused and
            the input is empty. Spans the same horizontal range as the
            expanded SearchPill (pill takes full-row width when focused
            via `expandedFull`, which is also left-4→right-4 of this
            header) by absolutely positioning with both edges instead
            of a fixed pixel width. */}
        <div
          className="absolute left-4 right-4 top-full z-30 mt-1 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md"
          style={{
            maxHeight: showTagCloud ? '220px' : '0px',
            opacity: showTagCloud ? 1 : 0,
            pointerEvents: showTagCloud ? 'auto' : 'none',
            transition:
              'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out',
          }}
        >
          <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
            {t('thoughts.tagFilter')}
          </div>
          <div className="flex max-h-[190px] flex-wrap gap-1.5 overflow-y-auto px-2 pb-2">
            {allTags.map(([tag, n]) => (
              <button
                key={tag}
                type="button"
                onMouseDown={(e) => {
                  // mousedown so we set state before the input's blur
                  // triggers and collapses the cloud.
                  e.preventDefault();
                  setActiveTag(tag);
                  searchInputRef.current?.blur();
                }}
                className="rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)]"
              >
                #{tag}
                <span className="ml-1 text-[var(--ink-muted)]/60">{n}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Input — new thought. Always visible regardless of viewMode (active
          vs. archived); the toggle below the input only filters the list, it
          shouldn't gate "create a new thought". v0.2.16 design correction:
          previously this was wrapped in `viewMode === 'active'`, which made
          users in the archived tab unable to write a new thought without
          flipping back first.
          Behaviour when creating from archived view:
            • new thought is always active (Thought.archived defaults to false)
            • optimistic prepend into `thoughts` would create a card that
              vanishes on next reload (the archived list doesn't contain it),
              so we instead flip viewMode → 'active' and clear filters; the
              `useEffect([reload, ...])` re-fetches the active list and the
              freshly created thought lands at the top as expected. */}
      <div className="p-3">
        <ThoughtInput
          onCreated={(t) => {
            if (viewMode === 'archived') {
              // Switching view will trigger reload() (via useCallback dep on
              // viewMode). Drop search/tag filters too so the new thought
              // — which may not match them — is guaranteed visible.
              setViewMode('active');
              setActiveTag(null);
              setQuery('');
              // Seed the active list with the new thought so the user sees
              // it even before the reload fetch returns. reload() will
              // overwrite with authoritative data right after.
              setThoughts([t]);
            } else {
              setThoughts((prev) => [t, ...prev]);
            }
          }}
          existingTags={tagCandidates}
          autoFocus={autoFocusInput}
          minLines={3}
        />
      </div>

      {/* Dynamic list header — occupies a consistent row above the cards
          so the layout doesn't shift when the filter chip appears:
            • default: 「想法 (N)」 on the left, right side reserved for
              future actions (e.g. sort, bulk-select).
            • when `activeTag` is set: the title flips to 「筛选」 and the
              filter chip replaces the count, so the state-change reads as
              in-place rather than a new row sliding in.
          No bottom border — visually the header and the card list read as
          a single surface. */}
      <div className="flex min-h-[34px] items-center justify-between px-4 py-1.5">
        {activeTag ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
              {t('thoughts.filter')}
            </span>
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--accent-warm-muted)] px-2 py-0.5 text-xs text-[var(--accent-warm)]"
              title={t('thoughts.clearFilter')}
            >
              #{activeTag}
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className="text-sm font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
            {t('records.title')}{' '}
            <span className="text-[var(--ink-muted)]/60">
              ({thoughts.length + audioRecords.length})
            </span>
          </span>
        )}
        <div className="ml-auto mr-2 flex items-center gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
          {(['all', 'text', 'audio'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter(kind)}
              className={`rounded-full px-2 py-0.5 text-xs transition-colors ${kindFilter === kind ? 'bg-[var(--paper-elevated)] font-medium text-[var(--ink)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
            >
              {t(`records.kind.${kind}`)}
            </button>
          ))}
        </div>
        {/* Right slot — v0.2.16: archive view toggle. Segmented control
            with two pills (活跃 / 已归档) sharing one pill background.
            Selecting a segment changes the panel's data source via
            `viewMode`. No per-segment count by user request (PRD §2.1). */}
        <div className="flex items-center gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
          {(
            [
              ['active', t('thoughts.viewActive')],
              ['archived', t('thoughts.viewArchived')],
            ] as const
          ).map(([mode, label]) => {
            const isActive = viewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  if (viewMode === mode) return;
                  setViewMode(mode);
                  // Reset auxiliary state that doesn't make sense after a
                  // viewMode flip: any active tag/query was scoped to the
                  // previous data set; multi-select selection becomes a
                  // mix of rows the user may no longer see.
                  setActiveTag(null);
                  setQuery('');
                  setSelectMode(false);
                  setSelectedIds(new Set());
                }}
                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                  isActive
                    ? 'bg-[var(--paper-elevated)] font-medium text-[var(--ink)] shadow-sm'
                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                }`}
                aria-pressed={isActive}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--ink-muted)]">
            {t('common.loading')}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--ink-muted)]">
            {thoughts.length + audioRecords.length === 0
              ? viewMode === 'archived'
                ? t('records.emptyArchived')
                : t('records.emptyActive')
              : t('records.emptySearch')}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {visibleItems.map((item) =>
              item.kind === 'text' ? (
                <ThoughtCard
                  key={item.thought.id}
                  thought={item.thought}
                  onChanged={(next) => handleCardChanged(item.thought.id, next)}
                  onDispatch={selectMode ? undefined : onDispatchThought}
                  onDiscuss={selectMode ? undefined : onDiscussThought}
                  onTagClick={setActiveTag}
                  searchQuery={query}
                  selectMode={selectMode}
                  selected={selectedIds.has(item.thought.id)}
                  onToggleSelect={() => toggleSelect(item.thought.id)}
                  onEnterSelectMode={() => enterSelectMode(item.thought.id)}
                />
              ) : (
                <AudioRecordCard
                  key={item.record.id}
                  record={item.record}
                  onOpen={(id, mediaMs) => onOpenRecord?.(id, mediaMs)}
                  onArchive={handleAudioArchive}
                  onDelete={() => setAudioDeleteTarget(item.record)}
                  selectMode={selectMode}
                  selected={selectedIds.has(item.record.id)}
                  onToggleSelect={() => toggleSelect(item.record.id)}
                  onEnterSelectMode={() => enterSelectMode(item.record.id)}
                  searchHit={recordSearchHits?.get(item.record.id)}
                />
              ),
            )}
          </div>
        )}
      </div>

      {/* Floating multi-select bar — bottom-of-screen pill. Only mounted in
          select mode so it doesn't accidentally swallow clicks the rest of
          the time. */}
      {selectMode && (
        <ThoughtBulkBar
          count={selectedIds.size}
          onMerge={() => void handleMerge()}
          onArchive={() => void handleBulkArchive()}
          onDelete={() => setConfirmDeleteOpen(true)}
          onCancel={exitSelectMode}
          viewMode={viewMode}
          busy={bulkBusy}
          mergeDisabledReason={
            selectionContainsAudio
              ? t('thoughts.mergeAudioUnsupported')
              : undefined
          }
        />
      )}

      {/* Delete confirmation — merge does NOT need confirmation per PRD,
          but bulk delete does. */}
      {confirmDeleteOpen && (
        <ConfirmDialog
          title={t('thoughts.deleteConfirmTitle')}
          message={t(
            selectionContainsAudio
              ? 'thoughts.deleteAudioConfirmMessage'
              : 'thoughts.deleteConfirmMessage',
            { count: selectedIds.size },
          )}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          confirmVariant="danger"
          loading={bulkBusy}
          onConfirm={() => void handleBulkDelete()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
      {audioDeleteTarget && (
        <ConfirmDialog
          title={t('records.deleteConfirmTitle')}
          message={t('records.deleteConfirmMessage')}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          confirmVariant="danger"
          onConfirm={() => void handleAudioDelete()}
          onCancel={() => setAudioDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default ThoughtPanel;
