Pod::Spec.new do |s|
  s.name           = 'DeviceKey'
  s.version        = '0.0.0'
  s.summary        = 'Biometry-bound P-256 device signing key (ADR 0017, M4-04).'
  s.author         = 'Ivan Baev'
  s.homepage       = 'https://github.com/IvanBBaev/remote-control'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
