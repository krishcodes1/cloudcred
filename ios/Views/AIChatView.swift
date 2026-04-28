//
//  AIChatView.swift
//  claudecredit
//
//  Premium conversational AI chat.
//  Credit — your personal finance assistant powered by Gemini 2.0 Flash.
//

import SwiftUI

// MARK: - Chat Message Model
struct ChatMessage: Identifiable, Equatable, Codable {
    let id: UUID
    let content: String
    let isUser: Bool
    let timestamp: Date
    var isLoading: Bool
    var isError: Bool

    init(id: UUID = UUID(), content: String, isUser: Bool,
         timestamp: Date, isLoading: Bool = false, isError: Bool = false) {
        self.id        = id
        self.content   = content
        self.isUser    = isUser
        self.timestamp = timestamp
        self.isLoading = isLoading
        self.isError   = isError
    }

    enum CodingKeys: String, CodingKey {
        case id, content, isUser, timestamp, isLoading, isError
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id        = try c.decode(UUID.self,   forKey: .id)
        content   = try c.decode(String.self, forKey: .content)
        isUser    = try c.decode(Bool.self,   forKey: .isUser)
        timestamp = try c.decode(Date.self,   forKey: .timestamp)
        isLoading = try c.decodeIfPresent(Bool.self, forKey: .isLoading) ?? false
        isError   = try c.decodeIfPresent(Bool.self, forKey: .isError)   ?? false
    }

    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool { lhs.id == rhs.id }
}

// MARK: - AI Chat View (Standalone)
struct AIChatView: View {
    @ObservedObject private var cardManager = CardManager.shared
    @ObservedObject private var aiService   = AIService.shared
    @ObservedObject private var agenticChat = AgenticChatClient.shared
    @ObservedObject private var chatStorage = ChatStorageService.shared
    @ObservedObject private var userPrefs   = UserPreferencesService.shared
    @ObservedObject private var subscriptionManager = SubscriptionManager.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var messages: [ChatMessage] = []
    @State private var inputText  = ""
    @State private var isLoading  = false
    @State private var streamingMessageId: UUID? = nil
    @State private var toolStatusText: String? = nil
    @FocusState private var isInputFocused: Bool
    @State private var pulseAvatar = false
    @State private var showTimestampForId: UUID? = nil
    @State private var showingPaywall = false

    /// Pre-filled question from another view (e.g. "Ask about this transaction")
    var prefillQuestion: String? = nil

    private let suggestions = [
        "How much did I spend this month?",
        "What's my biggest expense category?",
        "Any unusual charges lately?",
        "What subscriptions am I paying for?",
        "Am I on budget this month?"
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                LiquidGlassTheme.Colors.adaptiveBackground.ignoresSafeArea()

                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView(showsIndicators: false) {
                            LazyVStack(spacing: 4) {
                                if messages.isEmpty {
                                    welcomeSection.padding(.top, 24)
                                }
                                ForEach(messages) { message in
                                    ChatBubble(
                                        message: message,
                                        showTimestamp: showTimestampForId == message.id,
                                        onRetry: message.isError ? { retryLastMessage() } : nil
                                    )
                                    .id(message.id)
                                    .onTapGesture {
                                        withAnimation(.spring(response: 0.3)) {
                                            showTimestampForId = (showTimestampForId == message.id) ? nil : message.id
                                        }
                                    }
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.bottom, 16)
                        }
                        .onChange(of: messages.count) { _, _ in
                            if let last = messages.last {
                                withAnimation(.spring(response: 0.5)) {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                }
                            }
                        }
                    }

                    // Free tier message counter
                    if !subscriptionManager.effectiveIsPremium {
                        HStack(spacing: 6) {
                            Image(systemName: "sparkle")
                                .font(.system(size: 10))
                                .foregroundStyle(subscriptionManager.remainingFreeAIMessages > 0 ? .purple : .red)

                            Text("\(subscriptionManager.remainingFreeAIMessages)/\(PremiumFeature.freeAIChatDailyLimit) free messages today")
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)

                            Spacer()

                            Button {
                                showingPaywall = true
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "crown.fill")
                                        .font(.system(size: 9))
                                    Text("Upgrade")
                                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                                }
                                .foregroundStyle(.white)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(
                                    Capsule()
                                        .fill(LinearGradient(
                                            colors: [.purple, .blue],
                                            startPoint: .leading,
                                            endPoint: .trailing
                                        ))
                                )
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .background(LiquidGlassTheme.Colors.adaptiveBackground.opacity(0.95))
                    }

                    chatInputBar
                }
            }
            .sheet(isPresented: $showingPaywall) { PaywallView() }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(
                                    colors: [
                                        Color(red: 0.45, green: 0.25, blue: 0.95),
                                        Color(red: 0.30, green: 0.55, blue: 1.0)
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ))
                                .frame(width: 28, height: 28)
                            Image(systemName: "brain.head.profile")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Credit AI")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                            Text(toolStatusText ?? "Your financial advisor")
                                .font(.system(size: 10))
                                .foregroundStyle(toolStatusText != nil ? LiquidGlassTheme.Colors.accent : LiquidGlassTheme.Colors.textTertiary)
                                .animation(.easeInOut(duration: 0.2), value: toolStatusText)
                        }
                    }
                }

                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        withAnimation(.spring(response: 0.4)) {
                            messages.removeAll()
                            chatStorage.startNewSession()
                        }
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 14))
                            .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                    }
                    .opacity(messages.isEmpty ? 0.3 : 1)
                    .disabled(messages.isEmpty)
                }
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
                pulseAvatar = true
            }
            // Load existing messages from storage
            if messages.isEmpty && !chatStorage.messages.isEmpty {
                messages = chatStorage.messages
            }
            // Handle prefilled question from another view
            if let question = prefillQuestion, !question.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    sendMessage(question)
                }
            }
            // Fetch insights in background
            Task { await agenticChat.fetchInsights() }
        }
    }

    // MARK: - Welcome

    private var welcomeSection: some View {
        VStack(spacing: 28) {
            Spacer().frame(height: 20)

            // Animated floating orb with spinning gradient
            ZStack {
                FloatingOrbView(
                    colors: [
                        Color(red: 0.45, green: 0.25, blue: 0.95),
                        Color(red: 0.30, green: 0.50, blue: 1.0),
                        Color(red: 0.20, green: 0.70, blue: 0.90)
                    ],
                    size: 80
                )

                Image(systemName: "brain.head.profile")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(.white)
                    .shadow(color: .white.opacity(0.4), radius: 8)
            }

            VStack(spacing: 8) {
                if let name = userPrefs.userName {
                    Text("Hey \(name)")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                } else {
                    Text("Hey there")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                }

                Text("Ask me anything about your finances.\nI have access to all your data.")
                    .font(.system(size: 15, weight: .regular, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }

            // Quick stats
            quickStatsPill

            // Suggestions
            VStack(alignment: .leading, spacing: 10) {
                Text("SUGGESTIONS")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)
                    .tracking(1.2)
                    .padding(.leading, 4)

                FlowLayout(spacing: 8) {
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            sendMessage(suggestion)
                        } label: {
                            Text(suggestion)
                                .font(.system(size: 13, weight: .medium, design: .rounded))
                                .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(
                                    Capsule()
                                        .fill(colorScheme == .dark
                                            ? Color.white.opacity(0.08)
                                            : Color.black.opacity(0.05))
                                        .overlay(
                                            Capsule()
                                                .strokeBorder(
                                                    colorScheme == .dark
                                                        ? Color.white.opacity(0.1)
                                                        : Color.black.opacity(0.08),
                                                    lineWidth: 0.5
                                                )
                                        )
                                )
                        }
                    }
                }
            }

            Spacer().frame(height: 20)
        }
        .padding(.horizontal, 20)
    }

    private var quickStatsPill: some View {
        let allTx = cardManager.transactions.values.flatMap { $0 }
        let thisMonth = allTx.filter {
            Calendar.current.isDate($0.date, equalTo: Date(), toGranularity: .month)
        }
        let spent = thisMonth.filter { $0.isRealSpending }.reduce(0.0) { $0 + $1.amount }

        return HStack(spacing: 24) {
            VStack(spacing: 3) {
                Text(formatCurrency(spent))
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                Text("This Month")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
            }
            divider
            VStack(spacing: 3) {
                Text("\(thisMonth.count)")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                Text("Transactions")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
            }
            divider
            VStack(spacing: 3) {
                Text("\(cardManager.cards.count)")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                Text("Cards")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(LiquidGlassTheme.Colors.textTertiary)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(colorScheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(
                            colorScheme == .dark
                                ? Color.white.opacity(0.08)
                                : Color.black.opacity(0.06),
                            lineWidth: 0.5
                        )
                )
        )
    }

    private var divider: some View {
        Rectangle()
            .fill(LiquidGlassTheme.Colors.textQuaternary.opacity(0.3))
            .frame(width: 1, height: 28)
    }

    // MARK: - Input Bar

    private var chatInputBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(LiquidGlassTheme.Colors.textQuaternary.opacity(0.15))
                .frame(height: 0.5)

            HStack(alignment: .bottom, spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Message Credit AI...", text: $inputText, axis: .vertical)
                        .font(.system(size: 16, weight: .regular, design: .rounded))
                        .foregroundStyle(LiquidGlassTheme.Colors.textPrimary)
                        .focused($isInputFocused)
                        .lineLimit(1...5)
                        .submitLabel(.send)
                        .onSubmit {
                            let t = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !t.isEmpty { sendMessage(t) }
                        }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(colorScheme == .dark ? Color.white.opacity(0.07) : Color.black.opacity(0.04))
                        .overlay(
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .strokeBorder(
                                    isInputFocused
                                        ? LiquidGlassTheme.Colors.accent.opacity(0.5)
                                        : Color.clear,
                                    lineWidth: 1
                                )
                        )
                )
                .animation(.easeOut(duration: 0.2), value: isInputFocused)

                Button {
                    let t = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty, !isLoading else { return }
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    sendMessage(t)
                } label: {
                    ZStack {
                        Circle()
                            .fill(canSend
                                ? AnyShapeStyle(LinearGradient(
                                    colors: [
                                        Color(red: 0.45, green: 0.25, blue: 0.95),
                                        Color(red: 0.30, green: 0.55, blue: 1.0)
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ))
                                : AnyShapeStyle(colorScheme == .dark
                                    ? Color.white.opacity(0.1)
                                    : Color.black.opacity(0.08))
                            )
                            .frame(width: 36, height: 36)

                        if isLoading {
                            ProgressView()
                                .scaleEffect(0.6)
                                .tint(.white)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(canSend ? .white : LiquidGlassTheme.Colors.textQuaternary)
                        }
                    }
                }
                .disabled(!canSend)
                .animation(.easeOut(duration: 0.2), value: canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(LiquidGlassTheme.Colors.adaptiveBackground)
        }
    }

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isLoading
    }

    // MARK: - Actions

    private func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Check free tier AI limit
        if !subscriptionManager.canAccess(.unlimitedAIChat) {
            showingPaywall = true
            return
        }

        // Track AI usage for free tier
        subscriptionManager.recordAIMessage()

        let userMsg = ChatMessage(content: trimmed, isUser: true, timestamp: Date())
        messages.append(userMsg)
        chatStorage.addMessage(userMsg)
        inputText = ""
        isLoading = true
        isInputFocused = false

        userPrefs.learnFromMessage(trimmed)
        messages.removeAll { $0.isError }

        // Add a loading placeholder
        let loadingId = UUID()
        let loadingMsg = ChatMessage(id: loadingId, content: "", isUser: false, timestamp: Date(), isLoading: true)
        messages.append(loadingMsg)

        Task {
            await streamResponse(for: trimmed, loadingId: loadingId)
        }
    }

    /// Stream the AI response via SSE with real-time text and tool status updates.
    private func streamResponse(for query: String, loadingId: UUID) async {
        var accumulatedText = ""
        var receivedSessionId: UUID?

        do {
            try await agenticChat.streamChat(
                message: query,
                sessionId: chatStorage.currentSessionId
            ) { event in
                Task { @MainActor in
                    switch event {
                    case .session(let sid):
                        if let uuid = UUID(uuidString: sid) {
                            receivedSessionId = uuid
                            chatStorage.updateSessionId(uuid)
                        }

                    case .toolStart(let tool, _):
                        toolStatusText = toolStatusMessage(tool)
                        // Replace loading message with tool status
                        if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                            messages[idx] = ChatMessage(
                                id: loadingId,
                                content: toolStatusMessage(tool),
                                isUser: false,
                                timestamp: Date(),
                                isLoading: true
                            )
                        }

                    case .toolResult(_, _):
                        toolStatusText = nil

                    case .text(let content):
                        accumulatedText += content
                        toolStatusText = nil
                        // Update the streaming message in place
                        if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                            messages[idx] = ChatMessage(
                                id: loadingId,
                                content: accumulatedText,
                                isUser: false,
                                timestamp: Date(),
                                isLoading: false
                            )
                        }

                    case .fallback(let msg):
                        toolStatusText = msg

                    case .done(_, _, _):
                        toolStatusText = nil
                        isLoading = false
                        // Finalize the message
                        if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                            let finalMsg = ChatMessage(
                                id: loadingId,
                                content: accumulatedText.isEmpty ? "I couldn't generate a response. Please try again." : accumulatedText,
                                isUser: false,
                                timestamp: Date()
                            )
                            messages[idx] = finalMsg
                            chatStorage.addMessage(finalMsg)
                        }

                    case .error(let msg):
                        toolStatusText = nil
                        isLoading = false
                        if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                            messages[idx] = ChatMessage(
                                id: loadingId,
                                content: msg,
                                isUser: false,
                                timestamp: Date(),
                                isError: true
                            )
                        }
                    }
                }
            }
        } catch {
            // Streaming failed — try non-streaming fallback
            await MainActor.run {
                toolStatusText = nil
            }

            do {
                let response = try await agenticChat.sendChat(
                    message: query,
                    sessionId: chatStorage.currentSessionId
                )
                await MainActor.run {
                    if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                        let finalMsg = ChatMessage(
                            id: loadingId,
                            content: response.content,
                            isUser: false,
                            timestamp: Date()
                        )
                        messages[idx] = finalMsg
                        chatStorage.addMessage(finalMsg)
                    }
                    if let sid = response.sessionId, let uuid = UUID(uuidString: sid) {
                        chatStorage.updateSessionId(uuid)
                    }
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    if let idx = messages.firstIndex(where: { $0.id == loadingId }) {
                        messages[idx] = ChatMessage(
                            id: loadingId,
                            content: errorMessage(for: error),
                            isUser: false,
                            timestamp: Date(),
                            isError: true
                        )
                    }
                    isLoading = false
                }
            }
        }
    }

    private func retryLastMessage() {
        messages.removeAll { $0.isError }
        if let lastUserMsg = messages.last(where: { $0.isUser }) {
            sendMessage(lastUserMsg.content)
        }
    }

    private func errorMessage(for error: Error) -> String {
        if let aiErr = error as? AIError {
            return aiErr.userFacingMessage
        }
        if let urlErr = error as? URLError {
            switch urlErr.code {
            case .notConnectedToInternet, .networkConnectionLost:
                return "No internet connection. Check your network and try again."
            case .timedOut:
                return "Request timed out. Please try again."
            default:
                return "Network issue. Please try again."
            }
        }
        return "Something went wrong. Tap to retry."
    }

    private func formatCurrency(_ value: Double) -> String {
        if value >= 1_000 { return String(format: "$%.1fK", value / 1_000) }
        let f = NumberFormatter()
        f.numberStyle = .currency; f.currencyCode = "USD"; f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "$0"
    }
}

// MARK: - Modern Chat Bubble

struct ChatBubble: View {
    let message: ChatMessage
    var showTimestamp: Bool = false
    var onRetry: (() -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
            if message.isLoading {
                loadingIndicator
            } else if message.isError {
                errorCard
            } else {
                messageBubble
            }

            if showTimestamp && !message.isLoading {
                Text(message.timestamp.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textQuaternary)
                    .padding(.horizontal, message.isUser ? 4 : 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
        .padding(.top, message.isUser ? 8 : 4)
        .padding(.bottom, 2)
    }

    // MARK: - Message Bubble

    private var messageBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            if !message.isUser {
                aiIcon
                    .padding(.top, 2)
            }

            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 0) {
                Text(LocalizedStringKey(message.content))
                    .font(.system(size: 15, weight: .regular))
                    .lineSpacing(3)
                    .foregroundStyle(message.isUser ? .white : LiquidGlassTheme.Colors.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(
                        message.isUser ? userBubbleBackground : aiBubbleBackground
                    )
                    .clipShape(bubbleShape)
            }
            .frame(
                maxWidth: message.isUser ? 600 : 650,
                alignment: message.isUser ? .trailing : .leading
            )
        }
    }

    private var aiIcon: some View {
        ZStack {
            // Outer glow ring
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 0.55, green: 0.35, blue: 1.0).opacity(0.5),
                            Color(red: 0.35, green: 0.55, blue: 1.0).opacity(0.3),
                            .clear
                        ],
                        center: .center, startRadius: 2, endRadius: 18
                    )
                )
                .frame(width: 34, height: 34)

            // Main circle
            Circle()
                .fill(LinearGradient(
                    colors: [
                        Color(red: 0.45, green: 0.25, blue: 0.95),
                        Color(red: 0.30, green: 0.55, blue: 1.0)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 26, height: 26)
                .shadow(color: Color(red: 0.45, green: 0.25, blue: 0.95).opacity(0.6), radius: 8, x: 0, y: 0)

            Image(systemName: "brain.head.profile")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(color: .white.opacity(0.4), radius: 3)
        }
    }

    private var userBubbleBackground: AnyShapeStyle {
        AnyShapeStyle(LinearGradient(
            colors: [
                Color(red: 0.45, green: 0.25, blue: 0.95),
                Color(red: 0.35, green: 0.45, blue: 0.98)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        ))
    }

    private var aiBubbleBackground: AnyShapeStyle {
        AnyShapeStyle(colorScheme == .dark
            ? Color.white.opacity(0.07)
            : Color.black.opacity(0.05))
    }

    private var bubbleShape: UnevenRoundedRectangle {
        if message.isUser {
            return UnevenRoundedRectangle(
                topLeadingRadius: 20,
                bottomLeadingRadius: 20,
                bottomTrailingRadius: 6,
                topTrailingRadius: 20
            )
        } else {
            return UnevenRoundedRectangle(
                topLeadingRadius: 6,
                bottomLeadingRadius: 20,
                bottomTrailingRadius: 20,
                topTrailingRadius: 20
            )
        }
    }

    // MARK: - Typing Indicator

    private var loadingIndicator: some View {
        HStack(alignment: .top, spacing: 8) {
            aiIcon
                .padding(.top, 2)

            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    TypingDot(index: i)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(
                colorScheme == .dark
                    ? Color.white.opacity(0.07)
                    : Color.black.opacity(0.05)
            )
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: 6, bottomLeadingRadius: 20,
                    bottomTrailingRadius: 20, topTrailingRadius: 20
                )
            )
        }
    }

    // MARK: - Error Card

    private var errorCard: some View {
        HStack(alignment: .top, spacing: 8) {
            ZStack {
                Circle()
                    .fill(Color.orange.opacity(0.15))
                    .frame(width: 26, height: 26)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
            }
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 10) {
                Text(message.content)
                    .font(.system(size: 14, weight: .regular, design: .rounded))
                    .foregroundStyle(LiquidGlassTheme.Colors.textSecondary)
                    .lineSpacing(2)

                if let retry = onRetry {
                    Button(action: retry) {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Try again")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(
                            Capsule()
                                .fill(LinearGradient(
                                    colors: [.orange, .orange.opacity(0.8)],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                ))
                        )
                    }
                }
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.orange.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.orange.opacity(0.15), lineWidth: 0.5)
                    )
            )
        }
    }
}

// MARK: - Typing Dot

struct TypingDot: View {
    let index: Int
    @State private var isAnimating = false

    var body: some View {
        Circle()
            .fill(LiquidGlassTheme.Colors.textTertiary)
            .frame(width: 7, height: 7)
            .scaleEffect(isAnimating ? 1.0 : 0.5)
            .opacity(isAnimating ? 1.0 : 0.3)
            .animation(
                .easeInOut(duration: 0.6)
                .repeatForever(autoreverses: true)
                .delay(Double(index) * 0.2),
                value: isAnimating
            )
            .onAppear { isAnimating = true }
    }
}

// MARK: - Flow Layout

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = FlowResult(in: proposal.width ?? 0, spacing: spacing, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = FlowResult(in: bounds.width, spacing: spacing, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified
            )
        }
    }

    struct FlowResult {
        var positions: [CGPoint] = []
        var size: CGSize = .zero

        init(in maxWidth: CGFloat, spacing: CGFloat, subviews: Subviews) {
            var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
            for subview in subviews {
                let sz = subview.sizeThatFits(.unspecified)
                if x + sz.width > maxWidth && x > 0 {
                    x = 0; y += rowHeight + spacing; rowHeight = 0
                }
                positions.append(CGPoint(x: x, y: y))
                rowHeight = max(rowHeight, sz.height)
                x += sz.width + spacing
                self.size.width = max(self.size.width, x - spacing)
            }
            self.size.height = y + rowHeight
        }
    }
}

// MARK: - Preview
#Preview {
    AIChatView()
}
