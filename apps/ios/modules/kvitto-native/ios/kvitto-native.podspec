require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'kvitto-native'
  s.version        = package['version']
  s.summary        = 'Kvitto local Expo module for iOS-native imaging and storage primitives.'
  s.description    = 'Native iOS bridge for file-backed image descriptors, OCR, hashing, sharded storage and frame-analysis contracts.'
  s.homepage       = 'https://kvitto.app'
  s.license        = 'MIT'
  s.author         = 'Kvitto'
  s.platform       = :ios, '26.0'
  s.swift_version  = '5.10'
  s.source         = { :git => 'https://example.invalid/kvitto-native', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.frameworks = 'Vision', 'CoreImage', 'ImageIO', 'Accelerate', 'CryptoKit', 'UIKit', 'BackgroundTasks'
end
