//
//  ContentView.swift
//  claudecredit
//
//  Created by Krish shroff  on 1/28/26.
//

import SwiftUI

struct ContentView: View {
    @AppStorage("hasCompletedTutorial") private var hasCompletedTutorial = false
    // v2 is rolled back to opt-in. Default `false` matches
    // FeatureFlags.registerDefaults(). Settings → Features → "New Home (v2)"
    // still flips it back on for anyone who wants to try v2.
    @AppStorage(FeatureFlags.Keys.ccv2Enabled) private var ccv2Enabled = false

    var body: some View {
        ZStack {
            #if targetEnvironment(macCatalyst)
            MacDesktopView()
            #else
            if ccv2Enabled {
                MainTabViewV2()
            } else {
                MainTabView()
            }
            #endif

            // Show tutorial overlay for ALL users who haven't completed it.
            // v2 onboarding gated by the same flag as the v2 UI itself so the
            // two experiences stay consistent.
            if !hasCompletedTutorial {
                Group {
                    if ccv2Enabled {
                        OnboardingV2View()
                    } else {
                        HomeTutorialView()
                    }
                }
                .transition(.opacity)
                .zIndex(50)
            }
        }
    }
}

#Preview {
    ContentView()
        .preferredColorScheme(.dark)
}
