import { bootFailed, bootReady, initialBootState } from '../src/app/boot-state';

describe('boot state', () => {
  it('starts in loading state', () => {
    expect(initialBootState.status).toBe('loading');
  });

  it('transitions to ready', () => {
    expect(bootReady()).toEqual({ status: 'ready' });
  });

  it('captures diagnostics when startup fails', () => {
    const state = bootFailed('Could not initialize local services.', 'Keychain unavailable');

    expect(state.status).toBe('error');
    expect(state.diagnostics?.message).toBe('Could not initialize local services.');
    expect(state.diagnostics?.details).toBe('Keychain unavailable');
    expect(typeof state.diagnostics?.happenedAt).toBe('string');
  });
});
