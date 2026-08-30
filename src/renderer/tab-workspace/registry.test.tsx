import { act, render, renderHook, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';

import type { TabBase, TabModuleDefinition, TabRenderProps } from './contracts';
import {
  defineTabModules,
  parseRegisteredTab,
  resolveRestoreMount,
  resolveTabChrome,
  resolveTabIdentity,
  serializeRegisteredTab,
} from './registry';
import { useTabCloseController } from './useTabCloseController';
import { useTabWorkspaceController } from './useTabWorkspaceController';

interface ArticleTab extends TabBase<'article'> {
  slug: string;
  generation?: number;
}

type DashboardTab = TabBase<'dashboard'>;

type DownstreamTab = ArticleTab | DashboardTab;

const Article = ({ tab }: TabRenderProps<ArticleTab, Record<string, never>>) => <output>{tab.slug}</output>;
const Dashboard = () => null;

const articleModule = {
  kind: 'article',
  render: Article,
  chrome: (tab) => ({ title: tab.title, subtitle: tab.slug }),
  identity: (tab) => tab.slug,
  open: {
    findExisting: (tabs, intent) => tabs.find((tab) => tab.slug === intent.slug),
    create: (intent, { id }) => ({
      id,
      view: 'article',
      title: intent.title,
      slug: intent.slug,
      generation: intent.generation,
    }),
    reopen: (tab, intent) => ({
      ...tab,
      title: intent.title,
      generation: intent.generation,
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<
  ArticleTab,
  { slug: string; title: string; generation?: number },
  Record<string, never>
>;

const dashboardModule = {
  kind: 'dashboard',
  render: Dashboard,
  chrome: (tab) => ({ title: tab.title }),
  identity: () => 'dashboard',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'dashboard',
      title: intent.title,
    }),
  },
  initialMount: () => 'immediate',
} satisfies TabModuleDefinition<DashboardTab, { title: string }, Record<string, never>>;

type ArchiveTab = TabBase<'archive'>;
const archiveModule = {
  kind: 'archive',
  render: Dashboard as ComponentType<TabRenderProps<ArchiveTab, Record<string, never>>>,
  chrome: (tab: ArchiveTab) => ({ title: tab.title }),
  identity: () => 'archive',
  open: {
    findExisting: (tabs: readonly ArchiveTab[]) => tabs[0],
    create: (intent: { title: string }, { id }: { id: string }) => ({ id, view: 'archive' as const, title: intent.title }),
  },
  initialMount: () => 'immediate' as const,
} satisfies TabModuleDefinition<ArchiveTab, { title: string }, Record<string, never>>;

function missingDefinitionMustFailTypecheck() {
  // @ts-expect-error A downstream union cannot omit one of its module kinds.
  return defineTabModules<DownstreamTab>()({ article: articleModule });
}
void missingDefinitionMustFailTypecheck;

function extraDefinitionMustFailTypecheck() {
  return defineTabModules<DownstreamTab>()({
    article: articleModule,
    dashboard: dashboardModule,
    // @ts-expect-error A closed union cannot register a kind that it does not contain.
    archive: archiveModule,
  });
}
void extraDefinitionMustFailTypecheck;

describe('tab module registry', () => {
  it('closes a downstream edition over one exact definition per kind', () => {
    const modules = defineTabModules<DownstreamTab>()({
      article: articleModule,
      dashboard: dashboardModule,
    });
    expect(Object.keys(modules)).toEqual(['article', 'dashboard']);
    expect(Object.isFrozen(modules)).toBe(true);
    expect(Object.isFrozen(modules.article)).toBe(true);
    expect(Object.isFrozen(modules.article.open)).toBe(true);
  });

  it('resolves render-independent chrome, identity and mount policy', () => {
    const modules = defineTabModules<DownstreamTab>()({
      article: articleModule,
      dashboard: dashboardModule,
    });
    const tab: ArticleTab = {
      id: 'article-1',
      view: 'article',
      title: 'Architecture',
      slug: 'architecture',
    };
    expect(resolveTabChrome(modules, tab, { t: (key) => key })).toEqual({
      title: 'Architecture',
      subtitle: 'architecture',
    });
    expect(resolveTabIdentity(modules, tab)).toBe('architecture');
    expect(resolveRestoreMount(modules, tab)).toBe('deferred-content');
  });

  it('uses only codecs explicitly opted into by the closed composition', () => {
    const persistentArticleModule = {
      ...articleModule,
      persistence: {
        serialize: (tab: ArticleTab) => ({ view: 'article' as const, id: tab.id, slug: tab.slug }),
        parse: (value: unknown) => {
          if (typeof value !== 'object' || value === null) return null;
          const candidate = value as Record<string, unknown>;
          return candidate.view === 'article' &&
            typeof candidate.id === 'string' &&
            typeof candidate.slug === 'string'
            ? { view: 'article' as const, id: candidate.id, slug: candidate.slug }
            : null;
        },
        hydrate: (value: { view: 'article'; id: string; slug: string }): ArticleTab => ({
          ...value,
          title: value.slug,
        }),
        resourceIdentity: (value: { view: 'article'; id: string; slug: string }) => `article:${value.slug}`,
      },
    } satisfies TabModuleDefinition<
      ArticleTab,
      { slug: string; title: string; generation?: number },
      Record<string, never>,
      { view: 'article'; id: string; slug: string }
    >;
    const withoutCodec = defineTabModules<DownstreamTab>()({
      article: articleModule,
      dashboard: dashboardModule,
    });
    const withCodec = defineTabModules<DownstreamTab>()({
      article: persistentArticleModule,
      dashboard: dashboardModule,
    });
    const article: ArticleTab = {
      id: 'article-1',
      view: 'article',
      title: 'Architecture',
      slug: 'architecture',
    };

    expect(serializeRegisteredTab(withoutCodec, article)).toBeNull();
    expect(serializeRegisteredTab(withCodec, article)).toEqual({
      value: { view: 'article', id: 'article-1', slug: 'architecture' },
      resourceIdentity: 'article:architecture',
    });
    expect(parseRegisteredTab(withCodec, { view: 'unknown', id: 'x' })).toBeNull();
  });

  it('applies each definition restore mount policy instead of deferring every restored tab', () => {
    const modules = defineTabModules<DownstreamTab>()({
      article: articleModule,
      dashboard: dashboardModule,
    });
    const article: ArticleTab = {
      id: 'article-1',
      view: 'article',
      title: 'Architecture',
      slug: 'architecture',
    };
    const dashboard: DashboardTab = { id: 'dashboard-1', view: 'dashboard', title: 'Dashboard' };
    const hook = renderHook(() =>
      useTabWorkspaceController<DownstreamTab, typeof modules>({
        modules,
        initialTabs: [article],
        initialActiveTabId: article.id,
        maxTabs: 3,
        createId: () => 'unused',
        isLastTabProtected: () => false,
      }),
    );

    act(() => {
      hook.result.current.controller.restoreWithPolicy(
        { tabs: [dashboard], activeTabId: dashboard.id },
        (current, candidate) => ({ tabs: [...current, ...candidate.tabs], activeTabId: candidate.activeTabId! }),
      );
    });

    expect(hook.result.current.state.deferredMountTabIds.has(dashboard.id)).toBe(false);
  });

  it('lets a downstream harness render, reopen and default-close without App or TabBar switches', () => {
    const modules = defineTabModules<DownstreamTab>()({
      article: articleModule,
      dashboard: dashboardModule,
    });
    let nextId = 0;
    const dashboard: DashboardTab = {
      id: 'dashboard',
      view: 'dashboard',
      title: 'Dashboard',
    };
    const hook = renderHook(() => {
      const workspace = useTabWorkspaceController<DownstreamTab, typeof modules>({
        modules,
        initialTabs: [dashboard],
        initialActiveTabId: dashboard.id,
        maxTabs: 3,
        createId: () => `downstream-${++nextId}`,
        isLastTabProtected: () => false,
      });
      const close = useTabCloseController<DownstreamTab, typeof modules, 'user'>({
        workspace: workspace.controller,
        lifecycle: {},
        defaultReason: 'user',
        createFallback: () => dashboard,
      });
      return { ...workspace, close };
    });

    act(() => {
      hook.result.current.controller.open('article', {
        slug: 'architecture',
        title: 'Architecture',
        generation: 1,
      });
    });
    const opened = hook.result.current.state.tabs.find((tab): tab is ArticleTab => tab.view === 'article')!;
    const Renderer = modules.article.render;
    render(<Renderer tab={opened} isActive isDeferred={false} binding={{}} />);
    expect(screen.getByText('architecture')).toBeInTheDocument();

    act(() => {
      expect(
        hook.result.current.controller.open('article', {
          slug: 'architecture',
          title: 'Architecture updated',
          generation: 2,
        }).kind,
      ).toBe('reopened');
    });
    const reopened = hook.result.current.state.tabs.find((tab): tab is ArticleTab => tab.view === 'article')!;
    expect(reopened.id).toBe(opened.id);
    expect(reopened.generation).toBe(2);

    act(() => hook.result.current.close(reopened.id));
    expect(hook.result.current.state.tabs).toEqual([dashboard]);
  });
});
