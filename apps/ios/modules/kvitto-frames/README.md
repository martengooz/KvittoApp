# kvitto-frames

The live document detector for the scan screen's camera preview.

It is a **Nitro** module, and a separate one from `kvitto-native`, for two
reasons that are worth knowing before merging them back together.

**Why Nitro at all.** `react-native-vision-camera@5` removed the
frame-processor plugin API - there is no `FrameProcessorPlugin` class any more.
Frames arrive in `useFrameOutput`'s `onFrame`, a synchronous worklet running on
the camera's own thread, and the pixel buffer is valid only for the duration of
that call. An Expo module function cannot be called from there. A Nitro hybrid
object can.

**Why it is not part of `kvitto-native`.** Nitro compiles its pod with
`SWIFT_OBJC_INTEROP_MODE = objcxx`. `kvitto-native` depends on
`ExpoModulesCore`, which ships as a precompiled XCFramework; under C++ interop
Swift has to rebuild that module from its `.swiftinterface`, and it fails
outright with "this SDK is not supported by the compiler". Keeping the two
apart means neither has to compromise, and the frame detector has no use for
Expo anyway.

## Regenerating the bindings

After editing anything in `src/specs`:

```bash
cd apps/ios/modules/kvitto-frames
node ../../../../node_modules/nitrogen/lib/index.js --out ./ios/nitrogen/generated
cd ../../ios && pod install
```

The generated output under `ios/nitrogen/generated` is committed, so a clean
checkout builds without running nitrogen.
