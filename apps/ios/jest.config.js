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
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|expo(nent)?|@expo(nent)?/.*|expo-router|@expo/.*|react-navigation|@react-navigation/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
};
