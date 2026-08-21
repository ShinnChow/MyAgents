export type MainWindowPresentationReason =
  | 'initial'
  | 'focus-sample'
  | 'resize-zero'
  | 'resize-sample'
  | 'visibility-sample'
  | 'native-event'
  | 'hide-request'
  | 'hide-failed';

export interface MainWindowPresentation {
  /** Native window is shown and not minimized. Focus is intentionally excluded. */
  surfaceAvailable: boolean;
  /** Advances once when a renderable surface becomes unavailable. */
  generation: number;
}

export function createInitialMainWindowPresentation(
  surfaceAvailable: boolean,
): MainWindowPresentation {
  return {
    surfaceAvailable,
    generation: surfaceAvailable ? 0 : 1,
  };
}

export function reduceMainWindowPresentation(
  current: MainWindowPresentation,
  surfaceAvailable: boolean,
): MainWindowPresentation {
  if (current.surfaceAvailable === surfaceAvailable) return current;
  return {
    surfaceAvailable,
    generation: surfaceAvailable ? current.generation : current.generation + 1,
  };
}
