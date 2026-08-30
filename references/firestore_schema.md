# BURGONOMICS — Firestore Schema & Security (Layer 3 Constraint)

> **Reference Specification**: Single source of truth for Firestore database collections, TypeScript interfaces, security rules, indexes, and relations.  
> **Authoritative Sources**: [backend_upgrade_spec.md](backend_upgrade_spec.md) and [ui_ux_spec.md](ui_ux_spec.md).

---

## 1. Top-Level Collections Hierarchy

```
/firestore
  ├── branches/{branchId}
  ├── products/{productId}
  ├── users/{uid}
  ├── orders/{orderId}
  ├── support_tickets/{ticketId}
  ├── franchise_leads/{leadId}
  ├── coupons/{couponCode}
  ├── chats/{pairId}/messages/{messageId}
  ├── payment_audits/{auditId}
  └── dev_error_snapshots/{snapshotId}
```

---

## 2. Entity Schemas & TypeScript Interfaces

### `branches/{branchId}`
```typescript
interface Branch {
  id: string;
  name: string;                         // "Burgonomics Ahmedabad Prahlad Nagar"
  city: string;                         // "Ahmedabad"
  address: string;                      // "Shop 4, Gala Empire, Prahlad Nagar"
  phone: string;                        // "+919876543210"
  status: 'active' | 'upcoming' | 'paused';
  expectedOpenDate?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  operatingHours: {
    open: string;                       // "11:00"
    close: string;                      // "23:00"
  };
  supports: {
    delivery: boolean;
    takeaway: boolean;
    dineIn: boolean;
  };
  royaltyPercentage: number;            // e.g. 7.0 (Brand Royalty % on Food Subtotal)
  packagingFee?: number;                // e.g. 15 (₹15 standard packaging)
  razorpayAccountId: string;            // "acc_branch_ahmedabad_01" (Razorpay Route linked account)
  features: {
    porterEnabled: boolean;             // True if Porter courier API is active for this branch
  };
  petpooja: {
    restId: string;
    appKey: string;
    appSecret: string;
    accessToken: string;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### `products/{productId}`
```typescript
interface Product {
  id: string;
  name: string;                         // "Signature Smash Burger"
  description: string;
  price: number;                        // Authoritative MRP (₹149)
  category: string;                     // "smash_burgers" | "combos" | "sides" | "drinks" | "desserts"
  imageUrl: string;
  veg: boolean;                         // true (100% Pure Veg)
  bestseller: boolean;
  available: boolean;                   // Instant 86ing toggle via Petpooja webhook
  petpoojaItemId?: string;
  branchSpecificId?: string;            // Present if combo created by branch manager for single branch
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### `users/{uid}`
```typescript
interface UserProfile {
  uid: string;
  phone: string;
  name: string;
  email?: string;
  role: 'brand_owner' | 'developer' | 'support' | 'regional_manager' | 'branch_owner' | 'branch_staff' | 'customer';
  branchIds?: string[];                 // Scoped branches for branch staff/owners
  cityIds?: string[];                   // Scoped cities for regional managers
  loyaltyPoints: number;                // Global Grill Coins balance (1 coin = ₹1, max 20% redemption)
  totalOrders: number;
  addresses: Address[];
  fcmToken?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface Address {
  id: string;
  label: 'Home' | 'Work' | 'Other';
  street: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  isDefault: boolean;
}
```

### `orders/{orderId}`
```typescript
interface Order {
  id: string;                           // e.g. "BURG-2026-8921"
  customerId: string;
  customerName: string;
  customerPhone: string;
  branchId: string;
  branchName: string;
  fulfillment: {
    mode: 'delivery' | 'takeaway' | 'dinein';
    deliveryAddress?: Address;
    pickupPin?: string;                 // 4-digit code (e.g. "7419") for takeaway/dinein
  };
  items: Array<{
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
    imageUrl?: string;
  }>;
  specialNotes?: string;
  pricing: {
    subtotal: number;
    taxGst: number;                     // 5% GST
    packingCharge: number;              // ₹15.00
    deliveryFee: number;                // ₹0 if takeaway/dinein or >₹499; else Porter quote
    couponDiscount: number;
    loyaltyDiscount: number;            // Capped at max 20% of subtotal
    totalPayable: number;
  };
  payment: {
    method: 'razorpay' | 'cash';
    status: 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded';
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    royaltyRetained?: number;           // Amount kept in Brand Master Account
    branchTransferred?: number;         // Net amount routed to Branch Linked Account
  };
  status: 'pending' | 'accepted' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'cancelled';
  petpooja?: {
    petpoojaOrderId?: string;
    status: 'pending' | 'pushed' | 'accepted' | 'rejected' | 'failed';
    lastSyncAt: Timestamp;
  };
  porter?: {
    orderId?: string;
    trackingUrl?: string;
    driverName?: string;
    driverPhone?: string;
    status?: 'quoted' | 'driver_assigned' | 'in_transit' | 'delivered' | 'cancelled';
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### `support_tickets/{ticketId}`
```typescript
interface SupportTicket {
  id: string;
  orderId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  branchId: string;
  category: 'missing_item' | 'food_quality' | 'delivery_delay' | 'billing_issue' | 'other';
  description: string;
  photoUrls?: string[];
  status: 'open' | 'under_review' | 'resolved' | 'escalated' | 'closed';
  currentAssignee: {
    tier: 'branch_manager' | 'brand_owner' | 'support_team' | 'developer_team';
    assignedToId?: string;
  };
  resolution?: {
    type: 'refund' | 'coupon' | 'explanation' | 'rejected';
    amount?: number;
    couponCode?: string;
    note: string;
    resolvedBy: string;
    resolvedAt: Timestamp;
  };
  escalationHistory: Array<{
    fromTier: string;
    toTier: string;
    reason: string;
    timestamp: Timestamp;
  }>;
  lastActivityAt: Timestamp;
  createdAt: Timestamp;
}
```

### `payment_audits/{auditId}`
```typescript
interface PaymentAudit {
  id: string;
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  event: 'payment_verified' | 'refund_initiated' | 'dispute_logged';
  foodSubtotal: number;
  gstAmount: number;
  brandRoyaltyPaise: number;
  branchTransferPaise: number;
  status: 'success' | 'failed';
  ipAddress?: string;
  timestamp: Timestamp;
}
```

### `dev_error_snapshots/{snapshotId}`
```typescript
interface DevErrorSnapshot {
  id: string;
  source: 'payments' | 'petpooja' | 'porter' | 'tickets' | 'notifications' | 'auth' | 'system';
  severity: 'low' | 'medium' | 'high' | 'p0_critical';
  message: string;
  orderId?: string;
  branchId?: string;
  customerId?: string;                  // PII Masked in external webhooks (e.g. cu****12)
  errorStack?: string;
  context?: Record<string, unknown>;
  createdAt: Timestamp;
}
```

### `chats/{pairId}/messages/{messageId}`
```typescript
interface StaffMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
  orderReferenceId?: string;
  ticketReferenceId?: string;
  createdAt: Timestamp;
}
```
