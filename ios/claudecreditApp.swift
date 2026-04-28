//
//  claudecreditApp.swift
//  claudecredit
//
//  Created by Krish shroff  on 1/28/26.
//

import SwiftUI
import Combine
import BackgroundTasks
import FirebaseCore
import FirebaseAuth

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey : Any]? = nil) -> Bool {

        // Smart Refresh System — register BGAppRefreshTask handler.
        // Identifier must match Info.plist's BGTaskSchedulerPermittedIdentifiers.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "com.claudecredit.refresh",
            using: nil
        ) { task in
            let appTask = task as? BGAppRefreshTask
            Task { @MainActor in
                await AppServices.shared.refreshCoordinator.request(.backgroundTask)
                appTask?.setTaskCompleted(success: true)
            }
            appTask?.expirationHandler = {
                appTask?.setTaskCompleted(success: false)
            }
        }

        // Security: Migrate sensitive data from UserDefaults to Keychain
        SecureStorageService.shared.migrateFromUserDefaults(keys: SecureStorageService.legacyKeys)

        // Security: Device integrity check
        let assessment = SecurityService.shared.performSecurityCheck()
        if !assessment.isSecure {
            #if DEBUG
            print("SecurityService: Device integrity issues detected:")
            for issue in assessment.issues {
                print("  - \(issue)")
            }
            #endif
        }

        // Mac Catalyst window configuration
        #if targetEnvironment(macCatalyst)
        // Configure scenes after a brief delay so they're connected
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.forEach { windowScene in
                windowScene.sizeRestrictions?.minimumSize = CGSize(width: 1100, height: 700)
                windowScene.titlebar?.titleVisibility = .hidden
                windowScene.titlebar?.toolbar = nil
            }
        }
        #endif

        // Configure Firebase - must be done synchronously before any Firebase calls
        // Check if plist exists first
        if let plistPath = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
           let options = FirebaseOptions(contentsOfFile: plistPath) {

            // On Mac Catalyst, the bundle ID may differ from what's in the plist.
            // Force the bundle ID to match the iOS one so Firebase Auth works.
            #if targetEnvironment(macCatalyst)
            let currentBundleID = Bundle.main.bundleIdentifier ?? ""
            let firebaseBundleID = options.bundleID ?? ""
            if currentBundleID != firebaseBundleID {
                #if DEBUG
                print("⚠️ Firebase: Mac Catalyst bundle ID mismatch (\(currentBundleID) vs \(firebaseBundleID)). Overriding to match plist.")
                #endif
                options.bundleID = firebaseBundleID
            }
            #endif

            FirebaseApp.configure(options: options)
            #if DEBUG
            print("✅ Firebase: Configured successfully (bundle: \(options.bundleID ?? "unknown"))")
            #endif

            // On Mac Catalyst, use the default keychain access group
            // to avoid keychain entitlement issues
            #if targetEnvironment(macCatalyst)
            do {
                try Auth.auth().useUserAccessGroup(nil)
                #if DEBUG
                print("✅ Firebase Auth: Using default keychain access group (Mac Catalyst)")
                #endif
            } catch {
                #if DEBUG
                print("⚠️ Firebase Auth: Failed to set keychain access group: \(error.localizedDescription)")
                #endif
            }
            #endif

            // Notify that Firebase is ready
            NotificationCenter.default.post(name: NSNotification.Name("FirebaseConfigured"), object: nil)
        } else {
            #if DEBUG
            print("⚠️ Firebase: GoogleService-Info.plist not found - Firebase features disabled")
            #endif
        }
        return true
    }

    // Handle URL callbacks (e.g. Firebase Auth password reset links)
    func application(_ app: UIApplication,
                     open url: URL,
                     options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool {
        if Auth.auth().canHandle(url) {
            return true
        }
        return false
    }

    // MARK: - APNs (Smart Refresh System)

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        APNsRegistrationService.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        APNsRegistrationService.handleRegistrationFailure(error)
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        APNsRegistrationService.handleSilentPush(userInfo: userInfo, completionHandler: completionHandler)
    }
}

@MainActor
func scheduleNextBackgroundRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: "com.claudecredit.refresh")
    request.earliestBeginDate = AppServices.shared.usageTracker.suggestNextBackgroundRefresh()
    do {
        try BGTaskScheduler.shared.submit(request)
    } catch {
        print("[BG] BGAppRefreshTaskRequest submit failed: \(error)")
    }
}

@main
struct claudecreditApp: App {
    // Register app delegate for Firebase setup
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate

    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var appLockManager = AppLockManager.shared
    @StateObject private var themeManager = ThemeManager.shared

    init() {
        // Register feature-flag defaults BEFORE any @AppStorage reads them so
        // first-launch routing picks up the v2 home without a manual toggle.
        FeatureFlags.registerDefaults()

        // Configure navigation bar appearance for liquid glass theme
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundColor = .clear
        appearance.titleTextAttributes = [
            .foregroundColor: UIColor.white
        ]
        appearance.largeTitleTextAttributes = [
            .foregroundColor: UIColor.white
        ]

        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance

        // Configure tab bar appearance (iOS only — Mac uses sidebar)
        #if !targetEnvironment(macCatalyst)
        let tabBarAppearance = UITabBarAppearance()
        tabBarAppearance.configureWithTransparentBackground()
        tabBarAppearance.backgroundColor = UIColor(white: 0.1, alpha: 0.8)
        UITabBar.appearance().standardAppearance = tabBarAppearance
        UITabBar.appearance().scrollEdgeAppearance = tabBarAppearance
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appLockManager)
                .environmentObject(themeManager)
                .preferredColorScheme(themeManager.colorScheme)
                .background(
                    LiquidGlassTheme.Colors.adaptiveBackground
                        .ignoresSafeArea()
                )
                .onOpenURL { url in
                    // Handle Firebase Auth deep links (password reset, email verification, etc.)
                    _ = Auth.auth().canHandle(url)
                }
        }
        .onChange(of: scenePhase) { oldPhase, newPhase in
            // Preserve existing app-lock behavior
            appLockManager.handleScenePhaseChange(from: oldPhase, to: newPhase)

            // Smart Refresh System wiring
            switch newPhase {
            case .active:
                AppServices.shared.usageTracker.recordOpen()
                Task { @MainActor in
                    await AppServices.shared.refreshCoordinator.request(.appForeground)
                    if let predicted = PayrollPredictorBridge.nextPredictedPayDate() {
                        await AppServices.shared.refreshCoordinator.request(.paycheckWindow(predictedDate: predicted))
                    }
                }
            case .background:
                scheduleNextBackgroundRefresh()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}

// MARK: - App Lock Manager

@MainActor
class AppLockManager: ObservableObject {
    static let shared = AppLockManager()

    @Published var isLocked = true
    @Published var showLockScreen = false

    @AppStorage("biometricEnabled") var biometricEnabled = false
    @AppStorage("requireAuthOnLaunch") var requireAuthOnLaunch = true
    @AppStorage("lockOnBackground") var lockOnBackground = true
    @AppStorage("lockDelay") var lockDelay: Int = 0 // 0 = immediate, 30, 60, 300 seconds

    private var backgroundTime: Date?
    private let authManager = AuthenticationManager.shared

    private init() {
        // Check if we should show lock on launch
        if biometricEnabled && requireAuthOnLaunch {
            isLocked = true
            showLockScreen = true
        } else {
            isLocked = false
            showLockScreen = false
        }
    }

    func handleScenePhaseChange(from oldPhase: ScenePhase, to newPhase: ScenePhase) {
        switch newPhase {
        case .background:
            // Record when app went to background
            backgroundTime = Date()

        case .active:
            // Check if we need to lock
            if biometricEnabled && lockOnBackground {
                if let backgroundTime = backgroundTime {
                    let elapsed = Date().timeIntervalSince(backgroundTime)
                    if elapsed >= Double(lockDelay) {
                        isLocked = true
                        showLockScreen = true
                    }
                }
            }
            backgroundTime = nil

        case .inactive:
            break

        @unknown default:
            break
        }
    }

    func unlock() {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
            isLocked = false
            showLockScreen = false
        }
    }

    func lock() {
        isLocked = true
        showLockScreen = true
    }
}

// MARK: - Root View with Authentication

struct RootView: View {
    @ObservedObject private var authManager = AuthenticationManager.shared
    @EnvironmentObject private var appLockManager: AppLockManager
    @State private var isInitializing = true
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding = false

    var body: some View {
        ZStack {
            Group {
                if isInitializing {
                    // Show a splash/loading screen while Firebase initializes
                    SplashScreenView()
                } else if authManager.isAuthenticated && !hasCompletedOnboarding {
                    // First-time users see onboarding before the main app
                    OnboardingView()
                        .transition(.opacity)
                } else if authManager.isAuthenticated {
                    ContentView()
                } else {
                    AuthenticationView()
                }
            }

            // Lock screen overlay - appears on top of everything
            if appLockManager.showLockScreen && authManager.isAuthenticated && !isInitializing {
                AppLockScreenView()
                    .transition(.opacity.combined(with: .scale(scale: 1.1)))
                    .zIndex(100)
            }
        }
        .task {
            // Wait for Firebase auth state to resolve, with a max timeout
            // Firebase listener fires almost immediately once configured
            let start = Date()
            while authManager.currentUser == nil && Date().timeIntervalSince(start) < 1.5 {
                try? await Task.sleep(nanoseconds: 50_000_000) // 50ms polling
                if FirebaseApp.app() != nil { break }
            }
            // Brief settle time for auth state listener to fire
            try? await Task.sleep(nanoseconds: 200_000_000)

            // Auto-skip onboarding for existing users who already have cards
            if authManager.isAuthenticated && !hasCompletedOnboarding {
                if !CardManager.shared.cards.isEmpty {
                    hasCompletedOnboarding = true
                }
            }

            // Smart Refresh System — request APNs device token once auth is settled.
            // Service internally skips registration for anonymous users.
            if authManager.currentUser != nil {
                APNsRegistrationService.register()
            }

            withAnimation(.easeInOut(duration: 0.3)) {
                isInitializing = false
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, signedIn in
            // Re-register when a user signs in after launch (e.g. fresh sign-in
            // flow from the auth screen). Anonymous users are filtered inside.
            if signedIn {
                APNsRegistrationService.register()
            }
        }
    }
}

// MARK: - Splash Screen

struct SplashScreenView: View {
    @State private var logoScale: CGFloat = 0.8
    @State private var logoOpacity: Double = 0
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            LiquidGlassTheme.Colors.adaptiveBackground
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Image(systemName: "creditcard.fill")
                    .font(.system(size: 70))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                LiquidGlassTheme.Colors.accent,
                                LiquidGlassTheme.Colors.accentSecondary
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .scaleEffect(logoScale)
                    .opacity(logoOpacity)

                Text("Credit")
                    .font(LiquidGlassTheme.Fonts.largeTitle())
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                    .opacity(logoOpacity)

                ProgressView()
                    .tint(.white)
                    .scaleEffect(1.2)
                    .opacity(logoOpacity)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.7)) {
                logoScale = 1.0
                logoOpacity = 1.0
            }
        }
    }
}

// MARK: - App Lock Screen

struct AppLockScreenView: View {
    @EnvironmentObject private var appLockManager: AppLockManager
    @ObservedObject private var authManager = AuthenticationManager.shared
    @State private var isAuthenticating = false
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var iconScale: CGFloat = 1.0

    var body: some View {
        ZStack {
            // Background
            MeshGradientBackground()
                .ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                // Lock icon with animation
                ZStack {
                    Circle()
                        .fill(LiquidGlassTheme.Colors.accent.opacity(0.15))
                        .frame(width: 120, height: 120)

                    Image(systemName: authManager.getBiometricType().iconName)
                        .font(.system(size: 50))
                        .foregroundStyle(LiquidGlassTheme.Colors.accent)
                        .scaleEffect(iconScale)
                }

                VStack(spacing: 12) {
                    Text("App Locked")
                        .font(LiquidGlassTheme.Fonts.title())
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                    Text("Authenticate with \(authManager.getBiometricType().displayName) to continue")
                        .font(LiquidGlassTheme.Fonts.body())
                        .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }

                Spacer()

                // Unlock button
                Button {
                    authenticate()
                } label: {
                    HStack(spacing: 12) {
                        if isAuthenticating {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: authManager.getBiometricType().iconName)
                                .font(.system(size: 20))
                            Text("Unlock with \(authManager.getBiometricType().displayName)")
                                .font(LiquidGlassTheme.Fonts.headline())
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(LiquidGlassTheme.Colors.accent)
                    .foregroundStyle(.white)
                    .cornerRadius(LiquidGlassTheme.CornerRadius.lg)
                }
                .padding(.horizontal, 24)
                .disabled(isAuthenticating)

                // Sign out option
                // NOTE: Do NOT call appLockManager.unlock() here.
                // Signing out sets authManager.isAuthenticated = false, which causes
                // RootView to show AuthenticationView and automatically hides the lock overlay.
                // Calling unlock() would bypass biometric auth entirely.
                Button {
                    try? authManager.signOut()
                    appLockManager.lock() // Ensure lock state resets for next login
                } label: {
                    Text("Sign Out")
                        .font(LiquidGlassTheme.Fonts.subheadline())
                        .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
                }
                .padding(.bottom, 40)
            }
        }
        .alert("Authentication Failed", isPresented: $showError) {
            Button("Try Again") {
                authenticate()
            }
            #if targetEnvironment(macCatalyst)
            // On Mac without Touch ID, allow unlock via sign-out or skip
            if authManager.getBiometricType() == .none {
                Button("Continue Anyway") {
                    appLockManager.unlock()
                }
            }
            #endif
            Button("Cancel", role: .cancel) { }
        } message: {
            Text(errorMessage)
        }
        .task {
            // Auto-authenticate on appear
            try? await Task.sleep(nanoseconds: 300_000_000)
            authenticate()
        }
    }

    private func authenticate() {
        guard !isAuthenticating else { return }

        // Animate the icon
        withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
            iconScale = 0.9
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
                iconScale = 1.0
            }
        }

        isAuthenticating = true

        Task {
            do {
                let success = try await authManager.authenticateWithBiometrics()
                if success {
                    appLockManager.unlock()
                }
            } catch {
                // Check if user cancelled
                if let biometricError = error as? BiometricError,
                   case .authenticationFailed(let message) = biometricError,
                   (message.contains("canceled") || message.contains("Canceled")) {
                    // User cancelled - don't show error
                } else {
                    errorMessage = error.localizedDescription
                    showError = true
                }
            }
            isAuthenticating = false
        }
    }
}
