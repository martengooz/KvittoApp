module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.test.tsx'],
  // The workspace hoists a newer React to the repo root while the app pins its
  // own. Tests that render hooks must use the app's copy, or React sees two
  // dispatchers and every hook call fails.
  moduleNameMapper: {
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
  },
  // Reanimated's worklets boot a native VM on import, so any screen using a
  // swipe action throws at require time under Jest. This resolver (shipped by
  // react-native-worklets) steers those imports away from their `.native`
  // entry points. Without it, adding the first swipe action made the receipts
  // list screen impossible to import in a test - and nothing would have caught
  // that, because no test rendered that screen until this change added one.
  resolver: 'react-native-worklets/jest/resolver.js',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|expo(nent)?|@expo(nent)?/.*|expo-router|@expo/.*|react-navigation|@react-navigation/.*|unimodules|sentry-expo|native-base|react-native-svg|@shopify/flash-list|react-native-gesture-handler))',
  ],
};
