internal import Expo
import GoogleMobileAds
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    configureAdvertisingPrivacy()

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    excludeTrackerDatabaseFromBackup()
    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
  }

  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options)
      || RCTLinkingManager.application(app, open: url, options: options)
  }

  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let handled = RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
    return super.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    ) || handled
  }

  private func configureAdvertisingPrivacy() {
    let configuration = MobileAds.shared.requestConfiguration
    configuration.publisherPrivacyPersonalizationState = .disabled
    configuration.setPublisherFirstPartyIDEnabled(false)

    // QA physical-device test IDs are injected into Info.plist by the build
    // configuration. They are applied before React Native can initialize the
    // Google Mobile Ads SDK. Production builds deliberately receive no IDs.
    let buildProfile = Bundle.main.object(
      forInfoDictionaryKey: "GBTAdMobBuildProfile"
    ) as? String
    if buildProfile == "qa",
       let configuredIdentifiers = Bundle.main.object(
         forInfoDictionaryKey: "GBTAdMobTestDeviceIdentifiers"
       ) as? [String] {
      let identifiers = configuredIdentifiers
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      if !identifiers.isEmpty {
        configuration.testDeviceIdentifiers = identifiers
      }
    }
  }

  private func excludeTrackerDatabaseFromBackup() {
    guard let documentsDirectory = FileManager.default.urls(
      for: .documentDirectory,
      in: .userDomainMask
    ).first else { return }
    var sqliteDirectory = documentsDirectory.appendingPathComponent(
      "SQLite",
      isDirectory: true
    )
    try? FileManager.default.createDirectory(
      at: sqliteDirectory,
      withIntermediateDirectories: true
    )
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    try? sqliteDirectory.setResourceValues(resourceValues)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(
      forBundleRoot: ".expo/.virtual-metro-entry"
    )
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
