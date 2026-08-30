import type { TabBase } from '@/tab-workspace/contracts';
import type { PendingAppRoute } from '@/../shared/appRoute';

export interface TaskCenterSearchIntent {
  generation: number;
  autofocusSearch: true;
  consumed?: boolean;
}

export interface TaskCenterTab extends TabBase<'taskcenter'> {
  searchIntent?: TaskCenterSearchIntent;
  routeIntent?: PendingAppRoute;
  currentSessionId?: string | null;
}
