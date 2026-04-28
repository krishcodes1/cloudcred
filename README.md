# ClaudeCredit

A beautiful iOS credit card management app with Plaid integration and a liquid glass design following Apple's design language.

## Features

- 🏦 **Bank Integration** - Link your credit cards via Plaid (10,000+ supported banks)
- 💳 **Card Management** - View all your credit cards in one place
- 📊 **Balance Tracking** - Real-time balance and credit utilization
- 📈 **Spending Analytics** - Categorized spending breakdown
- 🔔 **Payment Reminders** - Never miss a payment due date
- 🔒 **Secure** - Bank-level security with Plaid

## Screenshots

The app features a modern liquid glass design with:
- Frosted glass card effects
- Animated gradient backgrounds
- Smooth animations and transitions
- Dark mode optimized UI

## Project Structure

```
claudecredit/
├── claudecredit/              # iOS App
│   ├── Design/                # Theme & styling
│   │   └── LiquidGlassTheme.swift
│   ├── Models/                # Data models
│   │   ├── CreditCard.swift
│   │   └── Transaction.swift
│   ├── Services/              # Business logic
│   │   ├── PlaidManager.swift
│   │   └── CardManager.swift
│   └── Views/                 # SwiftUI views
│       ├── DashboardView.swift
│       ├── CardDetailView.swift
│       ├── AddCardView.swift
│       ├── AllTransactionsView.swift
│       ├── SettingsView.swift
│       └── Components/
│           ├── CreditCardView.swift
│           ├── TransactionRow.swift
│           └── StatCard.swift
├── server/                    # Backend API
│   ├── index.js
│   ├── package.json
│   └── README.md
└── README.md
```

## Setup

### Prerequisites
- Xcode 15+
- iOS 17+
- Node.js 18+
- Plaid account (https://dashboard.plaid.com)

### 1. iOS App Setup

1. Open `claudecredit.xcodeproj` in Xcode
2. The Plaid SDK (LinkKit) is already added via Swift Package Manager
3. Build and run on simulator or device

### 2. Server Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env with your Plaid credentials
npm run dev
```

### 3. Configure Plaid

1. Sign up at https://dashboard.plaid.com
2. Get your Client ID and Secret from the Keys page
3. Add credentials to `server/.env`
4. Use sandbox mode for testing

### 4. Connect iOS to Server

Update the server URL in `PlaidManager.swift`:

```swift
static var serverBaseURL: String {
    // Local development
    return "http://localhost:3000"

    // Production
    // return "https://your-server.railway.app"
}
```

## Server Deployment

See [server/README.md](server/README.md) for deployment options.

**Recommended**: Railway ($5/month)
- One-click deploy
- Automatic HTTPS
- Easy environment variables

## Testing with Plaid Sandbox

Use these test credentials in sandbox mode:
- **Username**: `user_good`
- **Password**: `pass_good`

Or use the "Try Demo Mode" button in the app to see sample data without connecting a bank.

## Tech Stack

### iOS
- SwiftUI
- Combine
- CoreData
- Plaid LinkKit SDK

### Server
- Node.js
- Express
- Plaid Node SDK

## Design System

The app uses a custom "Liquid Glass" design system:

- **Colors**: Dark background with accent blues and purples
- **Cards**: Frosted glass effect with gradient overlays
- **Typography**: SF Pro Rounded font family
- **Animations**: Spring animations for interactions
- **Spacing**: Consistent 8pt grid system

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/plaid/create-link-token` | Initialize Plaid Link |
| `POST /api/plaid/exchange-token` | Get access token |
| `POST /api/plaid/accounts` | Fetch accounts |
| `POST /api/plaid/transactions` | Fetch transactions |
| `POST /api/plaid/liabilities` | Get credit details |

## Security

- Credentials never stored on device (Plaid handles auth)
- Access tokens stored in iOS UserDefaults (use Keychain for production)
- All API communication over HTTPS
- Plaid is SOC 2 Type II certified

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Support

For issues with:
- **This app**: Open a GitHub issue
- **Plaid integration**: https://plaid.com/docs
- **Banking connections**: Contact your bank
