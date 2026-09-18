require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'kvitto-frames'
  s.version        = package['version']
  s.summary        = 'Live document detection for the Kvitto scan camera.'
  s.description    = 'A Nitro hybrid object that runs Vision rectangle detection on VisionCamera frames.'
  s.homepage       = 'https://kvitto.app'
  s.license        = 'MIT'
  s.author         = 'Kvitto'
  s.platform       = :ios, '26.0'
  s.swift_version  = '5.10'
  s.source         = { :git => 'https://example.invalid/kvitto-frames', :tag => s.version.to_s }
  s.static_framework = true

  # Deliberately no ExpoModulesCore dependency. Nitro builds this pod with
  # `SWIFT_OBJC_INTEROP_MODE = objcxx`, under which Swift has to rebuild
  # ExpoModulesCore from its `.swiftinterface` - and that fails against the
  # precompiled XCFramework Expo ships. See this module's README.
  s.source_files = '*.{h,m,mm,swift}'
  s.frameworks = 'Vision', 'CoreVideo', 'CoreGraphics'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'kvitto_frames+autolinking.rb')
  add_nitrogen_files(s)
end
