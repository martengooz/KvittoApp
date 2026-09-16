# kvitto-native

Local Expo module for iOS-native storage, OCR, image processing and frame-analysis boundaries.

## Notes

- Live VisionCamera frame processor linking is intentionally not complete in this packet.
- `analyzeFrameCompact` returns explicit `pluginLinked: false` metadata so the JS layer can gate camera-specific paths without pretending integration is present.
