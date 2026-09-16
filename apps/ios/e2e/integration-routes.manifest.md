# iOS Integration Route Manifest

This manifest documents pushed/modal route skeletons wired in Wave 3 JS integration.

- receipt/[receiptId]
- receipt/[receiptId]/edit
- receipt/[receiptId]/ocr
- receipt/[receiptId]/extraction
- filters
- categories
- tags
- pairing/scanner
- debug/log
- archive/preflight
- archive/result

Scope: route shells only. Controller-backed screen implementations are tab-routed in app/(tabs) and service-composed in src/app/services.tsx.
