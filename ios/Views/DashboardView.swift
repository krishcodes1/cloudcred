//
//  DashboardView.swift
//  claudecredit
//
//  Created by Krish shroff on 1/28/26.
//

import SwiftUI

struct DashboardView: View {
    @ObservedObject private var cardManager = CardManager.shared
    @EnvironmentObject private var appLockManager: AppLockManager
    @State private var showingAddCard = false
    @State private var showingAddTransaction = false
    @State private var showingSettings = false
    @State private var showingInsights = false
    @State private var showingCreditScore = false
    @State private var showingCalendar = false
    @State private var showingGoals = false
    @State private var showingFinancialGoals = false
    @State private var showingRefreshOptions = false
    @State private var showingAIInsights = false
    @State private var showingTransactionReview = false
    @State private var showingWalletRewards = false
    @State private var showingRecap = false
    @State private var showingSavedReports = false
    @State private var selectedCard: CreditCard?
    @State private var currentCardIndex = 0
    @State private var refreshType: RefreshType = .all
    @State private var isRefreshing = false
    @ObservedObject private var aiService = AIService.shared
    @ObservedObject private var agenticChat = AgenticChatClient.shared
    @State private var showingAIChat = false
    @State private var aiChatPrefill: String? = nil

    enum RefreshType: String, CaseIterable {
        case balance = "Balance Only"
        case transactions = "Transactions Only"
        case all = "Balance & Transactions"

        var icon: String {
            switch self {
            case .balance: return "dollarsign.circle.fill"
            case .transactions: return "list.bullet.rectangle.fill"
            case .all: return "arrow.clockwise"
            }
        }
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ZStack {
                    // Background
                    MeshGradientBackground()
                        .ignoresSafeArea()

                    VStack(spacing: 0) {
                        // Custom header pinned to top edge
                        HStack {
                            Text("Credit")
                                .font(LiquidGlassTheme.Fonts.title())
                                .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                            Spacer()

                            Button {
                                showingSettings = true
                            } label: {
                                Image(systemName: "gearshape.fill")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                                    .frame(width: 38, height: 38)
                                    .glassCard(cornerRadius: 12)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                        .padding(.bottom, 4)

                        if cardManager.cards.isEmpty {
                            emptyStateView
                        } else {
                            mainContent
                        }
                    }

                    // Loading Overlay
                    if cardManager.isLoading {
                        loadingOverlay
                    }
                    
                    // Floating Action Button (only show if cards exist)
                    if !cardManager.cards.isEmpty {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Button {
                                    showingAddTransaction = true
                                } label: {
                                    Image(systemName: "plus")
                                        .font(.system(size: 24, weight: .semibold))
                                        .foregroundStyle(.white)
                                        .frame(width: 60, height: 60)
                                        .background(LiquidGlassTheme.Colors.accent)
                                        .clipShape(Circle())
                                        .shadow(color: .black.opacity(0.3), radius: 12, x: 0, y: 4)
                                }
                                .padding(.trailing, 20)
                                .padding(.bottom, 20)
                            }
                        }
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingAddCard) {
                AddCardView()
            }
            .sheet(isPresented: $showingAddTransaction) {
                AddTransactionView()
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
                    .environmentObject(appLockManager)
            }
            .sheet(item: $selectedCard) { card in
                CardDetailView(card: card)
            }
            .sheet(isPresented: $showingInsights) {
                InsightsView()
            }
            .sheet(isPresented: $showingCreditScore) {
                CreditScoreView()
            }
            .sheet(isPresented: $showingCalendar) {
                PaymentCalendarView()
            }
            .sheet(isPresented: $showingGoals) {
                SpendingGoalsView()
            }
            .sheet(isPresented: $showingAIInsights) {
                AIInsightsView()
            }
            .sheet(isPresented: $showingTransactionReview) {
                TransactionReviewView()
            }
            .sheet(isPresented: $showingWalletRewards) {
                WalletRewardsView()
            }
            .sheet(isPresented: $showingRecap) {
                FinancialRecapView()
            }
            .sheet(isPresented: $showingFinancialGoals) {
                FinancialGoalsView()
            }
            .sheet(isPresented: $showingSavedReports) {
                SavedReportsView()
            }
            .sheet(isPresented: $showingAIChat) {
                AIChatView(prefillQuestion: aiChatPrefill)
            }
        }
        .onAppear {
            Task { await agenticChat.fetchInsights() }
        }
    }

    // MARK: - AI Briefing Card

    private var aiBriefingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.purple)
                Text("AI Insights")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                Spacer()
                Button {
                    showingAIChat = true
                    aiChatPrefill = nil
                } label: {
                    HStack(spacing: 4) {
                        Text("Ask Credit")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .foregroundStyle(.purple)
                }
            }

            ForEach(agenticChat.serverInsights.prefix(3)) { insight in
                HStack(spacing: 10) {
                    Circle()
                        .fill(insightPriorityColor(insight.priority))
                        .frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(insight.title)
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                            .lineLimit(1)
                        Text(insight.description)
                            .font(.system(size: 11, weight: .regular, design: .rounded))
                            .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    Button {
                        Task { await agenticChat.dismissInsight(id: insight.id) }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)
                    }
                }
            }
        }
        .padding(16)
        .glassCard(cornerRadius: 16)
    }

    private func insightPriorityColor(_ priority: String) -> Color {
        switch priority {
        case "urgent": return .red
        case "high": return .orange
        case "medium": return .yellow
        default: return .blue
        }
    }

    // MARK: - Main Content

    private var mainContent: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                // Header with balance
                headerSection
                    .padding(.top, 16)
                    .padding(.bottom, 24)

                // AI Insights Briefing Card
                if !agenticChat.serverInsights.isEmpty {
                    aiBriefingCard
                        .padding(.horizontal, 20)
                        .padding(.bottom, 16)
                }

                // Review Transactions Banner (if there are unreviewed transactions)
                if aiService.unreviewedCount > 0 {
                    reviewTransactionsBanner
                        .padding(.horizontal, 20)
                        .padding(.bottom, 20)
                }

                // Cards Carousel
                cardsSection
                    .padding(.bottom, 20)

                // Quick Stats
                statsSection
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)

                // Quick Actions
                quickActionsSection
                    .padding(.horizontal, 20)
                    .padding(.bottom, 28)

                // Recent Transactions
                recentTransactionsSection
                    .padding(.bottom, 28)

                // Spending Breakdown
                spendingBreakdownSection
                    .padding(.bottom, 100)
            }
        }
        .refreshable {
            await cardManager.refreshAllCards()
        }
    }

    // MARK: - Loading Overlay

    private var loadingOverlay: some View {
        ZStack {
            Color.black.opacity(0.4)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                ProgressView()
                    .scaleEffect(1.2)
                    .tint(.white)

                Text("Updating...")
                    .font(LiquidGlassTheme.Fonts.subheadline())
                    .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
            }
            .padding(32)
            .glassCard()
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 24) {
                ZStack {
                    Circle()
                        .fill(LiquidGlassTheme.Colors.accent.opacity(0.15))
                        .frame(width: 100, height: 100)

                    Image(systemName: "creditcard.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(LiquidGlassTheme.Colors.accent)
                }

                VStack(spacing: 8) {
                    Text("No Cards Yet")
                        .font(LiquidGlassTheme.Fonts.title2())
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                    Text("Link your credit cards to start tracking your spending and balances.")
                        .font(LiquidGlassTheme.Fonts.body())
                        .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    showingAddCard = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .semibold))
                        Text("Add Your First Card")
                            .font(LiquidGlassTheme.Fonts.headline())
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 14)
                    .background {
                        Capsule()
                            .fill(LiquidGlassTheme.Colors.accent)
                    }
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 40)

            Spacer()
                .frame(height: 60)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(spacing: 6) {
            Text("Total Balance")
                .font(LiquidGlassTheme.Fonts.subheadline())
                .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)

            Text(formatCurrency(cardManager.totalBalance))
                .font(LiquidGlassTheme.Fonts.amountLarge())
                .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                .contentTransition(.numericText())

            HStack(spacing: 6) {
                Text("\(cardManager.cards.count) card\(cardManager.cards.count == 1 ? "" : "s")")
                    .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)

                if cardManager.totalCreditLimit > 0 {
                    Circle()
                        .fill(LiquidGlassTheme.Colors.textQuaternary)
                        .frame(width: 3, height: 3)

                    HStack(spacing: 4) {
                        Text("\(Int(cardManager.overallUtilization))%")
                            .foregroundStyle(utilizationColor)
                        Text("used")
                            .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
                    }
                }
            }
            .font(LiquidGlassTheme.Fonts.caption())
        }
    }

    // MARK: - Cards Section

    private var cardsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Your Cards")
                    .font(LiquidGlassTheme.Fonts.headline())
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                Spacer()

                Button {
                    showingAddCard = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(LiquidGlassTheme.Colors.accent)
                        .symbolRenderingMode(.hierarchical)
                }
            }
            .padding(.horizontal, 20)

            TabView(selection: $currentCardIndex) {
                ForEach(Array(cardManager.cards.enumerated()), id: \.element.id) { index, card in
                    CreditCardView(card: card)
                        .padding(.horizontal, 20)
                        .tag(index)
                        .scaleEntrance(delay: 0.15 + Double(index) * 0.05)
                        .onTapGesture {
                            selectedCard = card
                        }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .automatic))
            .frame(height: 220)

            // Payment Reminder
            if let nextPayment = cardManager.upcomingPayments.first {
                paymentReminderView(card: nextPayment.card, daysUntil: nextPayment.daysUntil)
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
            }
        }
    }

    private func paymentReminderView(card: CreditCard, daysUntil: Int) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill((daysUntil <= 3 ? LiquidGlassTheme.Colors.warning : LiquidGlassTheme.Colors.accent).opacity(0.15))
                    .frame(width: 42, height: 42)

                Image(systemName: "bell.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(daysUntil <= 3 ? LiquidGlassTheme.Colors.warning : LiquidGlassTheme.Colors.accent)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(daysUntil == 0 ? "Payment Due Today" : "Payment Due in \(daysUntil) days")
                    .font(LiquidGlassTheme.Fonts.subheadline())
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                Text("\(card.name) · Min: \(formatCurrency(card.minimumPayment ?? 0))")
                    .font(LiquidGlassTheme.Fonts.caption())
                    .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)
        }
        .padding(14)
        .glassCard(cornerRadius: LiquidGlassTheme.CornerRadius.lg)
    }

    // MARK: - Stats Section

    private var statsSection: some View {
        HStack(spacing: 12) {
            StatCard(
                title: "Available",
                value: formatCurrency(cardManager.totalAvailable),
                subtitle: nil,
                icon: "checkmark.circle.fill",
                iconColor: LiquidGlassTheme.Colors.success
            )

            StatCard(
                title: "Credit Limit",
                value: formatCurrency(cardManager.totalCreditLimit),
                subtitle: nil,
                icon: "arrow.up.circle.fill",
                iconColor: LiquidGlassTheme.Colors.accent
            )
        }
    }

    // MARK: - Quick Actions Section

    private var quickActionsSection: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                QuickActionButton(
                    title: "Add Card",
                    icon: "plus.circle.fill",
                    color: LiquidGlassTheme.Colors.accent
                ) {
                    showingAddCard = true
                }

                QuickActionButton(
                    title: isRefreshing ? "Refreshing..." : "Refresh All",
                    icon: "arrow.clockwise",
                    color: LiquidGlassTheme.Colors.success
                ) {
                    guard !isRefreshing else { return }
                    Task {
                        isRefreshing = true
                        await performRefresh(type: .all)
                        isRefreshing = false
                    }
                }
                .disabled(isRefreshing)
            }

            HStack(spacing: 12) {
                QuickActionButton(
                    title: "Insights",
                    icon: "chart.bar.fill",
                    color: LiquidGlassTheme.Colors.accentSecondary
                ) {
                    showingInsights = true
                }

                QuickActionButton(
                    title: "Score",
                    icon: "gauge.with.dots.needle.bottom.50percent",
                    color: LiquidGlassTheme.Colors.warning
                ) {
                    showingCreditScore = true
                }
            }

            HStack(spacing: 12) {
                QuickActionButton(
                    title: "Calendar",
                    icon: "calendar",
                    color: LiquidGlassTheme.Colors.accentTertiary
                ) {
                    showingCalendar = true
                }

                QuickActionButton(
                    title: "Goals",
                    icon: "target",
                    color: Color.pink
                ) {
                    showingGoals = true
                }
            }

            HStack(spacing: 12) {
                QuickActionButton(
                    title: "Rewards",
                    icon: "star.circle.fill",
                    color: .yellow
                ) {
                    showingWalletRewards = true
                }

                QuickActionButton(
                    title: "AI Insights",
                    icon: "brain.head.profile",
                    color: .purple
                ) {
                    showingAIInsights = true
                }
            }

            HStack(spacing: 12) {
                QuickActionButton(
                    title: "Review",
                    icon: "checkmark.circle",
                    color: .cyan
                ) {
                    showingTransactionReview = true
                }

                QuickActionButton(
                    title: "Recap",
                    icon: "doc.text.fill",
                    color: .teal
                ) {
                    showingRecap = true
                }
            }

            HStack(spacing: 12) {
                QuickActionButton(
                    title: "My Goals",
                    icon: "flag.checkered",
                    color: .mint
                ) {
                    showingFinancialGoals = true
                }

                QuickActionButton(
                    title: "Reports",
                    icon: "doc.text.magnifyingglass",
                    color: .indigo
                ) {
                    showingSavedReports = true
                }
            }
        }
    }

    // MARK: - Review Transactions Banner

    private var reviewTransactionsBanner: some View {
        Button {
            showingTransactionReview = true
        } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(Color.cyan.opacity(0.2))
                        .frame(width: 48, height: 48)

                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.cyan)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Review Your Transactions")
                        .font(LiquidGlassTheme.Fonts.subheadline())
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                    Text("\(aiService.unreviewedCount) transactions need your attention")
                        .font(LiquidGlassTheme.Fonts.caption())
                        .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)
            }
            .padding(14)
            .background(
                LinearGradient(
                    colors: [.cyan.opacity(0.15), .blue.opacity(0.1)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .glassCard(cornerRadius: LiquidGlassTheme.CornerRadius.lg)
        }
    }

    // MARK: - Recent Transactions Section

    private var recentTransactionsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Recent Activity")
                    .font(LiquidGlassTheme.Fonts.headline())
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)

                Spacer()

                NavigationLink {
                    AllTransactionsView()
                } label: {
                    Text("See All")
                        .font(LiquidGlassTheme.Fonts.subheadline())
                        .foregroundStyle(LiquidGlassTheme.Colors.accent)
                }
            }
            .padding(.horizontal, 20)

            let recentTransactions = allTransactions.prefix(4)

            if recentTransactions.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.system(size: 32))
                        .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)

                    Text("No transactions yet")
                        .font(LiquidGlassTheme.Fonts.subheadline())
                        .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
            } else {
                VStack(spacing: 2) {
                    ForEach(Array(recentTransactions.enumerated()), id: \.element.id) { index, transaction in
                        NavigationLink {
                            TransactionDetailView(transaction: transaction)
                        } label: {
                            TransactionRow(transaction: transaction)
                        }
                        .buttonStyle(PlainButtonStyle())
                        .staggeredEntrance(index: index, baseDelay: 0.2)
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }

    // MARK: - Spending Breakdown Section

    private var spendingBreakdownSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Spending by Category")
                .font(LiquidGlassTheme.Fonts.headline())
                .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                .padding(.horizontal, 20)

            let spending = cardManager.spendingByCategory()
            let totalSpending = spending.values.reduce(0, +)

            if spending.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "chart.pie")
                        .font(.system(size: 32))
                        .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)

                    Text("No spending data yet")
                        .font(LiquidGlassTheme.Fonts.subheadline())
                        .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
            } else {
                VStack(spacing: 0) {
                    let sortedSpending = spending.sorted { $0.value > $1.value }.prefix(5)

                    ForEach(Array(sortedSpending.enumerated()), id: \.element.key) { index, item in
                        SpendingCategoryRow(
                            category: item.key,
                            amount: item.value,
                            percentage: totalSpending > 0 ? (item.value / totalSpending) * 100 : 0
                        )
                        .staggeredEntrance(index: index, baseDelay: 0.15)

                        if index < sortedSpending.count - 1 {
                            Divider()
                                .background(LiquidGlassTheme.Colors.textQuaternary.opacity(0.3))
                                .padding(.horizontal, 16)
                        }
                    }
                }
                .glassCard(cornerRadius: LiquidGlassTheme.CornerRadius.xl)
                .padding(.horizontal, 20)
            }
        }
    }

    // MARK: - Helpers

    private var allTransactions: [Transaction] {
        cardManager.transactions.values.flatMap { $0 }.sorted { $0.date > $1.date }
    }

    private var utilizationColor: Color {
        if cardManager.overallUtilization < 30 {
            return LiquidGlassTheme.Colors.success
        } else if cardManager.overallUtilization < 70 {
            return LiquidGlassTheme.Colors.warning
        } else {
            return LiquidGlassTheme.Colors.danger
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        if value >= 1000 {
            formatter.maximumFractionDigits = 0
        } else {
            formatter.maximumFractionDigits = 2
        }
        return formatter.string(from: NSNumber(value: value)) ?? "$0"
    }

    private func performRefresh(type: RefreshType) async {
        switch type {
        case .balance:
            await cardManager.refreshBalancesOnly()
        case .transactions:
            await cardManager.refreshTransactionsOnly()
        case .all:
            await cardManager.refreshAllCards()
        }
    }
}

// MARK: - Preview
#Preview {
    DashboardView()
}
