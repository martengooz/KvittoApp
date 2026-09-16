export type BootStatus = 'loading' | 'ready' | 'error';

export type BootDiagnostics = {
  message: string;
  details?: string;
  happenedAt: string;
};

export type BootState = {
  status: BootStatus;
  diagnostics?: BootDiagnostics;
};

export const initialBootState: BootState = {
  status: 'loading',
};

export function bootReady(): BootState {
  return { status: 'ready' };
}

export function bootFailed(message: string, details?: string): BootState {
  return {
    status: 'error',
    diagnostics: {
      message,
      details,
      happenedAt: new Date().toISOString(),
    },
  };
}
