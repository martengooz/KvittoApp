import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'KvittoApp iOS',
  slug: 'kvitto-ios',
  version: '0.1.0',
  scheme: ['kvittoapp', 'kvittoapp-ios'],
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // New Architecture is mandatory and always on as of Expo SDK 57; no config flag exists.
  experiments: {
    typedRoutes: true,
  },
  extra: {
    router: {
      root: 'app',
    },
  },
  plugins: [
    'expo-router',
    [
      'expo-sqlite',
      {
        enableFTS: true,
        useSQLCipher: true,
      },
    ],
    'expo-secure-store',
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: '26.0',
        },
      },
    ],
  ],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.kvitto.app.ios',
    deploymentTarget: '26.0',
    infoPlist: {
      NSCameraUsageDescription:
        'KvittoApp uses the camera to scan and process receipts on-device.',
      NSPhotoLibraryUsageDescription:
        'KvittoApp imports receipt photos from your photo library.',
      NSPhotoLibraryAddUsageDescription:
        'KvittoApp saves processed receipt images when you choose to export them.',
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Kvitto Archive',
          LSHandlerRank: 'Owner',
          LSItemContentTypes: ['com.kvitto.archive.kvitto'],
        },
      ],
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: 'com.kvitto.archive.kvitto',
          UTTypeDescription: 'Kvitto Archive',
          UTTypeConformsTo: ['public.zip-archive', 'public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['kvitto'],
            'public.mime-type': ['application/x-kvitto-archive'],
          },
        },
      ],
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [],
    },
  },
};

export default config;
