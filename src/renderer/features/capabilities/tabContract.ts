import type { TabBase } from '@/tab-workspace/contracts';
import type { OfficialToolId } from '@/../shared/official-tools';
import type { CapabilityInitialSelect } from '@/../shared/skillsTypes';

export type CapabilitySection = 'skills' | 'plugins' | 'mcp';

export interface CapabilitiesNavigationIntent {
  generation: number;
  section: CapabilitySection;
  mcpServerId?: string;
  officialToolId?: OfficialToolId;
  select?: CapabilityInitialSelect;
}

export interface CapabilitiesTab extends TabBase<'capabilities'> {
  navigationIntent?: CapabilitiesNavigationIntent;
}
