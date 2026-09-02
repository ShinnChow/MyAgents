import type { TabBase } from '@/tab-workspace/contracts';
import type { PendingAppRoute } from '@/../shared/appRoute';

export interface SpaceTab extends TabBase<'space'> {
  navigationIntent?: PendingAppRoute;
}
