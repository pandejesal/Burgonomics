# Upcoming stores — source and display policy

## Primary source

Owner-designated local website data:
`C:\Users\DELL\Desktop\BURGONOMICS WEBSITE\burgonomics final ebsite - Copy\src\components\Locations\locationsData.js`
(SHA-256 `9a01dc89df1b5793eec2f86d2a2856dd572c013ed0db81e074412aa61df2c851`).

The live public page `https://burgonomics.com/locations` returned HTTP 200 and is
snapshotted as `website-locations.html` (SHA-256
`c4642e93858b98fd8fba4250c0e703c993512959ec44b580b9e3200cab710748`). Its SPA
bundle did not contain the location records in a directly extractable form, so the
local data file is the authoritative list. **No record was merged from guesswork.**

## Entries marked `status: "upcoming"` (8)

| Store | City / state | Address as supplied | Opening text as supplied |
|---|---|---|---|
| Gor Dhod Road | Surat, Gujarat | Gor Dhod Road | October 2026 |
| Vallabh Vidhyanagar | Anand, Gujarat | Vallabh Vidhyanagar – 388120 | October 2026 |
| Hinjawadi Phase 2 | Pune, Maharashtra | VJ Happiness Street, Hinjawadi Phase 2 – 411057 | October 2026 |
| Patan | Patan, Gujarat | Patan | October 2026 |
| Tin Batti | Daman | Seaface Road, near Taxi Stand, Tin Batti – 396210 | TBA |
| Chandra Park | Rajkot, Gujarat | Chandra Park 2 Corner, near Big Bazar, opposite Reliance Mall, 150 Feet Ring Road – 360005 | TBA |
| Ghatlodiya | Ahmedabad, Gujarat | S One Commercial, Maharana Pratap Road, Chanakyapuri – 380061 | TBA |
| Mehsana | Mehsana, Gujarat | Radhanpur Road, opposite Ravi Shopping, near Dwarkapuri Flats – 384002 | TBA |

## Display policy

- Label them **Upcoming stores** with the caption "Announced openings — not yet
  orderable."
- "October 2026" is shown as **planned**, not promised. "TBA" renders as
  "Opening date to be announced".
- An announcement never creates an orderable outlet, never enables delivery to
  that city, and never appears in the store selector.
- Order matters only for reading: alphabetical by store name in the app so the
  list does not imply a sequence.
- Records with `status: "new"` (Urban Chowk, Narayanpura, VR Mall, CBD Mall,
  New Ranip) are already-open/new outlets in the website data and are **not**
  treated as upcoming.

## Staleness

The local data says "October 2026" for four entries and today is 29 October 2026,
so those dates may already have passed. The app says "Planned" rather than
"Opening soon", and the owner should refresh the list before release.
