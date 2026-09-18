import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SettingsFeatureScreen } from '../src/app/settings-screen';
import { SettingsFeatureController } from '../src/features/settings/controller';
import {
  DEFAULT_COMPANY_SETTINGS,
  type SecureCredentialSnapshot,
  type SecureCredentialsPort,
} from '../src/features/settings/types';

const EMPTY_CREDENTIALS: SecureCredentialSnapshot = {
  pairingToken: null,
  aiApiKey: null,
  companyApiKey: null,
};

class InMemorySecureCredentials implements SecureCredentialsPort {
  state: SecureCredentialSnapshot = { ...EMPTY_CREDENTIALS };

  async get(): Promise<SecureCredentialSnapshot> {
    return { ...this.state };
  }

  async set(next: SecureCredentialSnapshot): Promise<void> {
    this.state = { ...next };
  }

  async clear(): Promise<void> {
    this.state = { ...EMPTY_CREDENTIALS };
  }
}

function makeController(secure: SecureCredentialsPort): SettingsFeatureController {
  return new SettingsFeatureController({
    pairing: { serverUrl: '', paired: false, deviceName: 'iPhone', accountHint: null },
    image: { autoCapture: true, jpegQuality: 0.9, colorMode: 'grayscale' },
    ocr: { languages: ['sv-SE'], languageCorrection: true },
    ai: { mode: 'none', provider: 'none', model: 'none' },
    company: DEFAULT_COMPANY_SETTINGS,
    sync: { autoSync: true, wifiOnly: true },
    migration: { lastImportAt: null, lastExportAt: null, lastPreflightSummary: null },
    storage: { blobCount: 0, blobBytes: 0, hasPersistentStorage: true },
    about: { appName: 'Kvitto', appVersion: '1.0.0', nativeVersion: '57' },
    secureCredentials: secure,
    diagnostics: { read: async () => ({ status: 'ok' }) },
  });
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function render(
  controller: SettingsFeatureController,
  searchBudgetUsed?: () => Promise<number>,
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <SettingsFeatureScreen
        controller={controller}
        startupSteps={['opened database']}
        searchBudgetUsed={searchBudgetUsed}
      />,
    );
  });
  await flush();
  return renderer!;
}

function byLabel(renderer: ReactTestRenderer, label: string) {
  const [found] = renderer.root.findAll((node) => node.props?.accessibilityLabel === label);
  return found;
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

describe('the settings screen', () => {
  test('scrolls, so the cards below the fold can be reached', async () => {
    /*
     * Settings grows a card per feature and had no ScrollView, which put
     * Credentials - and now the company key field - off the bottom of the
     * screen with no way to get to them. This is the same defect the filters
     * sheet shipped with, so it is worth a test rather than a comment.
     */
    const renderer = await render(makeController(new InMemorySecureCredentials()));

    const scrollViews = renderer.root.findAll(
      (node) => typeof node.type !== 'string' && /ScrollView/.test(String((node.type as { displayName?: string; name?: string }).displayName ?? (node.type as { name?: string }).name ?? '')),
    );
    expect(scrollViews.length).toBeGreaterThan(0);

    await act(async () => renderer.unmount());
  });

  test('stores a company API key and then reports it as set', async () => {
    const secure = new InMemorySecureCredentials();
    const renderer = await render(makeController(secure));

    await act(async () => {
      byLabel(renderer, 'Company API key').props.onChangeText('  sk_test_abc  ');
    });
    await act(async () => {
      byLabel(renderer, 'Save company key').props.onPress();
    });
    await flush();

    // Trimmed on the way in: a pasted key routinely carries whitespace, and a
    // key with a trailing space is rejected by the API as a wrong key.
    expect(secure.state.companyApiKey).toBe('sk_test_abc');
    expect(textOf(renderer)).toContain('Company API key: set');

    await act(async () => renderer.unmount());
  });

  test('clears the field after saving, so the key is not left on screen', async () => {
    const secure = new InMemorySecureCredentials();
    const renderer = await render(makeController(secure));

    await act(async () => {
      byLabel(renderer, 'Company API key').props.onChangeText('sk_test_abc');
    });
    await act(async () => {
      byLabel(renderer, 'Save company key').props.onPress();
    });
    await flush();

    expect(byLabel(renderer, 'Company API key').props.value).toBe('');
    await act(async () => renderer.unmount());
  });

  test('never puts a stored key back into the field', async () => {
    // Presence is reported; the secret itself is not read back. Otherwise
    // opening Settings would put an API key on screen every time.
    const secure = new InMemorySecureCredentials();
    await secure.set({ ...EMPTY_CREDENTIALS, companyApiKey: 'sk_live_secret' });

    const renderer = await render(makeController(secure));

    expect(byLabel(renderer, 'Company API key').props.value).toBe('');
    expect(textOf(renderer)).not.toContain('sk_live_secret');
    expect(textOf(renderer)).toContain('Company API key: set');

    await act(async () => renderer.unmount());
  });

  test('will not save an empty key over a real one', async () => {
    const secure = new InMemorySecureCredentials();
    await secure.set({ ...EMPTY_CREDENTIALS, companyApiKey: 'sk_live_secret' });
    const renderer = await render(makeController(secure));

    expect(byLabel(renderer, 'Save company key').props.disabled).toBe(true);

    await act(async () => {
      byLabel(renderer, 'Company API key').props.onChangeText('   ');
    });
    expect(byLabel(renderer, 'Save company key').props.disabled).toBe(true);
    expect(secure.state.companyApiKey).toBe('sk_live_secret');

    await act(async () => renderer.unmount());
  });

  test('stores an AI key too, which had no way in at all before', async () => {
    const secure = new InMemorySecureCredentials();
    const renderer = await render(makeController(secure));

    await act(async () => {
      byLabel(renderer, 'AI API key').props.onChangeText('sk-ant-123');
    });
    await act(async () => {
      byLabel(renderer, 'Save AI key').props.onPress();
    });
    await flush();

    expect(secure.state.aiApiKey).toBe('sk-ant-123');
    await act(async () => renderer.unmount());
  });

  test('saving one key leaves the other alone', async () => {
    const secure = new InMemorySecureCredentials();
    await secure.set({ pairingToken: 'pair-1', aiApiKey: 'ai-1', companyApiKey: null });
    const renderer = await render(makeController(secure));

    await act(async () => {
      byLabel(renderer, 'Company API key').props.onChangeText('co-1');
    });
    await act(async () => {
      byLabel(renderer, 'Save company key').props.onPress();
    });
    await flush();

    expect(secure.state).toEqual({ pairingToken: 'pair-1', aiApiKey: 'ai-1', companyApiKey: 'co-1' });
    await act(async () => renderer.unmount());
  });

  test('toggling lookup off is what the next scan reads', async () => {
    const controller = makeController(new InMemorySecureCredentials());
    const renderer = await render(controller);

    await act(async () => {
      byLabel(renderer, 'Look up after a scan').props.onValueChange(false);
    });
    await flush();

    expect((await controller.getSnapshot()).company.autoLookup).toBe(false);
    await act(async () => renderer.unmount());
  });

  test('shows how much of the scarce name-search quota is spent', async () => {
    const renderer = await render(makeController(new InMemorySecureCredentials()), async () => 7);

    expect(textOf(renderer)).toContain('7 used today');
    await act(async () => renderer.unmount());
  });

  test('renders without a budget reader, since one needs the composition', async () => {
    const renderer = await render(makeController(new InMemorySecureCredentials()));

    expect(textOf(renderer)).toContain('Company lookup');
    expect(textOf(renderer)).not.toContain('used today');
    await act(async () => renderer.unmount());
  });
});
