# BURGONOMICS — Deployment Strategy & Native Mobile Builds (Layer 3 Constraint)

> **Factory Configuration**: Build pipelines, Capacitor iOS/Android configurations, Firebase Cloud Functions deployment, and environment variable management.

---

## 1. Native Mobile Builds (Capacitor iOS & Android)

Both Customer (`burgonomics-foundation-core`) and Partner (`burgonomics-partner`) applications target native mobile App Store and Play Store releases via Capacitor.

### Build Verification Commands
```bash
# 1. Web production build
npm run build

# 2. Mobile Capacitor bundle build
npm run build:mobile

# 3. Sync web assets to native projects
npx cap sync
```

### Native Permissions & Plugins
- `@capacitor/push-notifications`: FCM native push token registration.
- `@capacitor/geolocation`: Accurate GPS coordinates for delivery address verification.
- `@capacitor/haptics`: Tactile feedback on button presses and cart additions.
- `@capacitor/camera`: Camera access for profile avatar uploads and issue reporting photos.

---

## 2. Firebase Backend Deployment (`asia-south1`)

Cloud Functions v2 and Firestore security rules are deployed via Firebase CLI:

```bash
# Deploy Firestore rules & indexes
firebase deploy --only firestore

# Deploy Cloud Functions v2
firebase deploy --only functions

# Deploy Cloud Storage rules
firebase deploy --only storage
```

---

## 3. Environment Variables & Secret Invariants

| Environment Variable | Target | Description |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | Client App | Firebase Web Client API Key |
| `VITE_FIREBASE_PROJECT_ID` | Client App | Firebase Project ID (`burgonomics-app`) |
| `RAZORPAY_KEY_ID` | Functions / Client | Razorpay Public Key |
| `RAZORPAY_KEY_SECRET` | Secret Manager | Razorpay Secret Key for HMAC & Route API |
| `PETPOOJA_APP_KEY` | Secret Manager | Petpooja API Key |
| `PETPOOJA_APP_SECRET` | Secret Manager | Petpooja API Secret |
| `PORTER_API_KEY` | Secret Manager | Porter Logistics API Key |
