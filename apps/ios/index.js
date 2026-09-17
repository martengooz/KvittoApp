// The Web Crypto polyfill must be installed before any module that reads
// `globalThis.crypto` at load time, so it is imported ahead of the router entry.
import './src/app/polyfills';

import 'expo-router/entry';
