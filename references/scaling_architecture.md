# BURGONOMICS — Dynamic Multi-Branch Scaling (Layer 3 Constraint)

> **Reference Specification**: Zero-code-change branch onboarding, franchise lead management, and geo-spatial store discovery.

---

## 1. Dynamic Branch Creation
- New franchise branches are created directly via Firestore writes (`branches/{branchId}`) from the Partner App without rebuilding or redeploying client apps.
- On creation:
  - Branch Manager assigned role claims (`branchId`).
  - Branch POS linked to Razorpay Route account ID.
  - Petpooja credentials configured for automated menu ingestion.

---

## 2. Franchise Lead Pipeline
- Prospective franchise partners submit leads via Customer app (`/profile/franchise` or Home Franchise Banner).
- Leads saved in `franchise_leads/{id}`.
- Partner app provides a dedicated pipeline dashboard for Brand Owners to review, contact, and onboard franchise applicants.
