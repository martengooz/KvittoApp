module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/test/**/*.test.ts', '**/test/**/*.test.tsx'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|expo(nent)?|@expo(nent)?/.*|expo-router|@expo/.*|react-navigation|@react-navigation/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
};
