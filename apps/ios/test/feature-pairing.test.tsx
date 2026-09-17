/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { parsePairingPayload } from '../src/features/pairing/payload';
import { PairingScannerScreen } from '../src/features/pairing/scanner-view';
import { SettingsFeatureController } from '../src/features/settings';

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function textOf(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' | ');
}

function control(renderer: ReactTestRenderer, label: string, handler: string): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.[handler] === 'function',
  );
  if (matches.length === 0) throw new Error(`No control “${label}”. Rendered: ${textOf(renderer)}`);
  return matches[matches.length - 1]!;
}

describe('pairing payload', () => {
  test('reads a kvitto:// pairing URL', () => {
    const result = parsePairingPayload(
      'kvitto://pair?server=https%3A%2F%2Fsync.example.com&token=abc123&account=acct-1&device=Marten%20iPhone',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.serverUrl).toBe('https://sync.example.com/');
    expect(result.payload.token).toBe('abc123');
    expect(result.payload.accountId).toBe('acct-1');
    expect(result.payload.deviceName).toBe('Marten iPhone');
  });

  test('reads the equivalent JSON, since a code may arrive pasted', () => {
    const result = parsePairingPayload(
      JSON.stringify({ serverUrl: 'https://sync.example.com', token: 'abc123', accountId: null }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.token).toBe('abc123');
    expect(result.payload.accountId).toBeNull();
  });

  test('refuses http, because the token is sent to that host on every sync', () => {
    const result = parsePairingPayload('kvitto://pair?server=http%3A%2F%2Fsync.example.com&token=abc123');
    expect(result).toEqual({ ok: false, reason: 'The server address must use https.' });
  });

  test('refuses a payload with no token', () => {
    const result = parsePairingPayload('kvitto://pair?server=https%3A%2F%2Fsync.example.com');
    expect(result.ok).toBe(false);
  });

  test('refuses a payload with no server', () => {
    const result = parsePairingPayload('kvitto://pair?token=abc123');
    expect(result.ok).toBe(false);
  });

  test('refuses another app’s deep link', () => {
    const result = parsePairingPayload('otherapp://pair?server=https%3A%2F%2Fx.example.com&token=t');
    expect(result).toEqual({ ok: false, reason: 'That is not a KvittoApp pairing code.' });
  });

  test('refuses junk, blank input, and malformed JSON', () => {
    expect(parsePairingPayload('not a code').ok).toBe(false);
    expect(parsePairingPayload('   ').ok).toBe(false);
    expect(parsePairingPayload('{"serverUrl":').ok).toBe(false);
  });

  test('no rejection reason echoes the input back', () => {
    const secret = 'super-secret-token-value';
    const results = [
      parsePairingPayload(`kvitto://pair?server=http%3A%2F%2Fx.example.com&token=${secret}`),
      parsePairingPayload(`otherapp://pair?token=${secret}`),
      parsePairingPayload(`nonsense ${secret}`),
    ];

    // An error message is shown on screen and may be copied into a report; a
    // bearer token must not travel with it.
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).not.toContain(secret);
    }
  });
});

describe('pairing scanner screen', () => {
  function makeController() {
    const pairing: Record<string, unknown>[] = [];
    const credentials: Record<string, unknown>[] = [];
    const controller = {
      setSecureCredentials: async (patch: Record<string, unknown>) => {
        credentials.push(patch);
      },
      updatePairing: async (patch: Record<string, unknown>) => {
        pairing.push(patch);
      },
    } as unknown as SettingsFeatureController;
    return { controller, pairing, credentials };
  }

  async function render(controller: SettingsFeatureController, cameraAvailable = false, onPaired?: () => void) {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <PairingScannerScreen controller={controller} cameraAvailable={cameraAvailable} onPaired={onPaired} />,
      );
    });
    await flush();
    return renderer!;
  }

  async function type(renderer: ReactTestRenderer, value: string) {
    await act(async () => {
      (control(renderer, 'Pairing code', 'onChangeText').props as { onChangeText: (v: string) => void })
        .onChangeText(value);
    });
  }

  async function press(renderer: ReactTestRenderer, label: string) {
    await act(async () => {
      (control(renderer, label, 'onPress').props as { onPress: () => void }).onPress();
    });
    await flush();
    await flush();
  }

  test('pairing stores the token and the server, and dismisses', async () => {
    const { controller, pairing, credentials } = makeController();
    let dismissed = false;
    const renderer = await render(controller, false, () => (dismissed = true));

    await type(renderer, 'kvitto://pair?server=https%3A%2F%2Fsync.example.com&token=abc123&account=acct-1');
    await press(renderer, 'Pair device');

    expect(credentials).toEqual([{ pairingToken: 'abc123' }]);
    expect(pairing[0]).toMatchObject({
      serverUrl: 'https://sync.example.com/',
      paired: true,
      accountHint: 'acct-1',
    });
    expect(dismissed).toBe(true);

    await act(async () => renderer.unmount());
  });

  test('the token is cleared from the field once it has been stored', async () => {
    const { controller } = makeController();
    const renderer = await render(controller);

    await type(renderer, 'kvitto://pair?server=https%3A%2F%2Fsync.example.com&token=abc123');
    await press(renderer, 'Pair device');

    expect(control(renderer, 'Pairing code', 'onChangeText').props.value).toBe('');
    await act(async () => renderer.unmount());
  });

  test('a bad code is reported and nothing is stored', async () => {
    const { controller, pairing, credentials } = makeController();
    const renderer = await render(controller);

    await type(renderer, 'kvitto://pair?server=http%3A%2F%2Fsync.example.com&token=abc123');
    await press(renderer, 'Pair device');

    expect(textOf(renderer)).toContain('must use https');
    expect(credentials).toEqual([]);
    expect(pairing).toEqual([]);

    await act(async () => renderer.unmount());
  });

  test('without a camera the screen says so rather than showing a dead viewfinder', async () => {
    const { controller } = makeController();
    const renderer = await render(controller, false);

    expect(textOf(renderer)).toContain('No camera is available');
    await act(async () => renderer.unmount());
  });

  test('with a camera it is honest that live scanning is not wired yet', async () => {
    const { controller } = makeController();
    const renderer = await render(controller, true);

    expect(textOf(renderer)).toContain('not wired up yet');
    await act(async () => renderer.unmount());
  });
});
