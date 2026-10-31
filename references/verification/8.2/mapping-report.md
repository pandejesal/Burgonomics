# 8.2 Mapping Report — staged menu photos → menuData items

- Generated: 2026-10-04T21:33:45+00:00
- Sources: `finale - Copy.zip` → `src/components/Menu/menuData.js` (56 items), `ULTRA FINAL MENU PICS (2).zip` (43 photos)
- Staged output: `43` files under `images\`, 6,742,204 bytes total — all ≤ 1200 px and ≤ 300 KB

## Matching method
1. **image-field anchor** — the item's own `image` path in menuData points at this file.
2. **in-scope name match** — photo folder maps to a menu scope (table below); best similarity > 0.5 and ≥ 1 shared informative token (exact, shared prefix ≥ 3 chars, shared substring ≥ 4 chars, or word ratio ≥ 0.85). Similarity = max(SequenceMatcher ratio, token containment).
3. **cross-category name match** — scope had no hit; same rule against all items, but requiring score ≥ 0.65 and ≥ 1 exactly shared word.
4. **generic category match** — stem is only generic words (e.g. `MOMOS`) and is contained in the item name.
Generic words excluded from the informative-token test: a, an, and, burger, burgers, coffee, combo, combos, drink, drinks, fries, fry, iced, it, meal, momo, momos, of, pasta, pizza, plus, sauce, shake, shakes, tea, the, with

## Folder → menu scope
| Photo folder | Menu scope |
|---|---|
| Beverages | Coolers / Shakes |
| Big Bang | Burgers > Big Bang Burgers |
| Brownie | Desserts |
| Classic Burgers | Burgers > Classic Burgers |
| Cold Coffee | Cold Coffee |
| Fries | Sides |
| Meals | Combos |
| Momos | Momos |
| Pasta | Pasta |
| Pizza | Pizza |
| Shakes | Shakes |
| (root) | (no folder — global search) |

## Per-image mapping
| Image | Folder scope | Content | Size (px / bytes) | Similarity | Matched menu item(s) | Method |
|---|---|---|---|---|---|---|
| `images/Beverages/Lemon Iced Tea.jpg` | Coolers / Shakes | JPEG | 900×900 / 117,039 | 1.00 | Lemon Iced Tea [Coolers] | in-scope name match |
| `images/Beverages/Peach.jpg` | Coolers / Shakes | JPEG | 900×900 / 117,039 | 1.00 | Peach Iced Tea [Coolers] | in-scope name match |
| `images/Big Bang/Burning Man.jpeg` | Burgers > Big Bang Burgers | JPEG | 900×900 / 171,683 | 0.50 | **NONE** — nearest: Cheese Burst Burger (0.50) | no match |
| `images/Big Bang/Cheese burst.jpg` | Burgers > Big Bang Burgers | JPEG | 900×900 / 117,833 | 1.00 | Cheese Burst Burger [Burgers] | image-field anchor |
| `images/Big Bang/Farm Fresh.jpg` | Burgers > Big Bang Burgers | JPEG | 900×900 / 122,278 | 0.60 | **NONE** — nearest: Mint Fries (0.60) | no match |
| `images/Big Bang/Great Indian.jpg` | Burgers > Big Bang Burgers | JPEG | 900×900 / 127,194 | 1.00 | Great Indian Burger [Burgers] | image-field anchor |
| `images/Big Bang/Super Hero.jpg` | Burgers > Big Bang Burgers | JPEG | 900×900 / 155,328 | 1.00 | Super Hero Burger [Burgers] | image-field anchor |
| `images/Big Bang/tandoori paneer.jpg` | Burgers > Big Bang Burgers | JPEG | 1200×1200 / 166,795 | 1.00 | Tandoori Paneer Burger [Burgers] | image-field anchor |
| `images/Brownie/Chocolate Brownie.png` | Desserts | JPEG | 1200×1200 / 255,143 | 1.00 | Chocolate Brownie [Desserts] | in-scope name match |
| `images/Classic Burgers/Hero burgr.jpg` | Burgers > Classic Burgers | JPEG | 1200×1200 / 137,884 | 1.00 (+1 more) | Hero Burger [Burgers]; Jr. Hero Burger [Burgers] | in-scope name match |
| `images/Classic Burgers/Jr. Hero.jpeg` | Burgers > Classic Burgers | JPEG | 900×900 / 158,080 | 1.00 (+1 more) | Jr. Hero Burger [Burgers]; Hero Burger [Burgers] | in-scope name match |
| `images/Classic Burgers/Korean Kimchi.JPG` | Burgers > Classic Burgers | JPEG | 1200×1200 / 157,848 | 1.00 | Korean Kimchi Burger [Burgers] | in-scope name match |
| `images/Classic Burgers/Mexican.jpg` | Burgers > Classic Burgers | JPEG | 1200×1200 / 166,795 | 1.00 | Mexican Mafia Burger [Burgers] | in-scope name match |
| `images/Classic Burgers/red hot.JPG` | Burgers > Classic Burgers | JPEG | 1200×1200 / 177,716 | 0.47 | **NONE** — nearest: Oreo Shake (0.47) | no match |
| `images/Classic Burgers/Veggie loaded.jpg` | Burgers > Classic Burgers | JPEG | 900×900 / 127,194 | 1.00 | Veggie Loaded Burger [Burgers] | in-scope name match |
| `images/Cold Coffee/Hazelnut.jpg` | Cold Coffee | JPEG | 900×900 / 118,508 | 1.00 | Hazlenut Cold Coffee [Cold Coffee] | in-scope name match |
| `images/Cold Coffee/Irish.jpg` | Cold Coffee | JPEG | 900×900 / 98,456 | 1.00 | Irish Cold Coffee [Cold Coffee] | in-scope name match |
| `images/Cold Coffee/Mocha.jpg` | Cold Coffee | JPEG | 900×900 / 76,893 | 0.42 | **NONE** — nearest: Lemon Iced Tea (0.42) | no match |
| `images/Cold Coffee/Oreo.JPG` | Cold Coffee | JPEG | 1200×1200 / 168,596 | 1.00 (+1 more) | Oreo Shake [Shakes]; Strawberry Oreo Shake [Shakes] | cross-category name match |
| `images/Fries/Dirty fries.jpg` | Sides | JPEG | 1200×1200 / 239,199 | 1.00 | Dirty Fries [Sides] | image-field anchor |
| `images/Fries/Peri Peri Cheesy.jpeg` | Sides | JPEG | 1200×1200 / 249,504 | 1.00 (+1 more) | Peri Peri Cheese Fries [Sides]; Peri Peri Fries [Sides] | in-scope name match |
| `images/Fries/Peri peri fries.JPG` | Sides | JPEG | 1200×1200 / 186,025 | 1.00 (+1 more) | Peri Peri Fries [Sides]; Peri Peri Cheese Fries [Sides] | in-scope name match |
| `images/Fries/Salted fries.jpg` | Sides | JPEG | 1200×901 / 156,487 | 1.00 | Classic Salted Fries [Sides] | in-scope name match |
| `images/Meals/big bang meal.JPG` | Combos | JPEG | 1200×1200 / 114,250 | 1.00 | Any Big Bang Burger Meal [Combos] | in-scope name match |
| `images/Meals/coke + cheese burst.png` | Combos | JPEG | 1024×940 / 133,870 | 1.00 | Cheese Burst Burger [Burgers] | cross-category name match |
| `images/Meals/hero meal.JPG` | Combos | JPEG | 1200×1200 / 204,704 | 1.00 (+1 more) | Jr Hero Burger Meal [Combos]; 2 Jr. Hero Burger [Combos] | in-scope name match |
| `images/Meals/Kimchi + coffee.png` | Combos | JPEG | 1024×937 / 120,532 | 1.00 | Korean Kimchi Burger [Burgers] | cross-category name match |
| `images/Meals/Red Hot meal.jpg` | Combos | JPEG | 1200×800 / 136,684 | 0.62 | **NONE** — nearest: Make It A Meal (0.62) | no match |
| `images/Meals/Strawberry shake + Veggie loaded burger.png` | Combos | JPEG | 1024×1024 / 113,102 | 1.00 | Veggie Loaded Burger [Burgers] | cross-category name match |
| `images/Momos/MOMOS.JPG` | Momos | JPEG | 1200×1200 / 202,305 | 0.71 (+2 more) | Veg Momos [Momos]; Kurkure Momos [Momos]; Veg Cheese Momos [Momos] | generic category match |
| `images/MYOB.png` | (no folder — global search) | JPEG | 1080×1080 / 143,276 | 0.31 | **NONE** — nearest: Veg Momos (0.31) | no match |
| `images/Pasta/Pink and Arrabiata.JPG` | Pasta | JPEG | 1200×1200 / 256,187 | 1.00 (+1 more) | Pink Sauce Pasta [Pasta]; Arrabiata Pasta [Pasta] | in-scope name match |
| `images/Pasta/White Sauce.png` | Pasta | JPEG | 1200×1200 / 295,503 | 1.00 | White Sauce Pasta [Pasta] | in-scope name match |
| `images/Pizza/4 cheese.png` | Pizza | JPEG | 1024×683 / 95,938 | 1.00 | Cheese Heaven Pizza [Pizza] | image-field anchor |
| `images/Pizza/margherita pizza.png` | Pizza | JPEG | 1013×739 / 119,665 | 1.00 | Margherita Pizza [Pizza] | in-scope name match |
| `images/Pizza/Tandoori paneer pizza.png` | Pizza | JPEG | 1024×937 / 184,122 | 1.00 | Tandoori Paneer Pizza [Pizza] | in-scope name match |
| `images/Pizza/veggie loaded pizza.jpg` | Pizza | JPEG | 1200×1200 / 258,297 | 1.00 | The Veg Overload Pizza [Pizza] | in-scope name match |
| `images/Shakes/Biscoff Shake.png` | Shakes | JPEG | 876×876 / 82,566 | 0.61 | **NONE** — nearest: Oreo Shake (0.61) | no match |
| `images/Shakes/Chocolate.JPG` | Shakes | JPEG | 1200×1200 / 145,133 | 1.00 | Chocolate Shake [Shakes] | in-scope name match |
| `images/Shakes/Cookie Crumble.JPG` | Shakes | JPEG | 1200×1200 / 168,596 | 0.39 | **NONE** — nearest: Tandoori Paneer Burger (0.39) | no match |
| `images/Shakes/Nutella.JPG` | Shakes | JPEG | 1200×1200 / 145,133 | 0.38 | **NONE** — nearest: Lemon Iced Tea (0.38) | no match |
| `images/Shakes/Oreo.JPG` | Shakes | JPEG | 1200×1200 / 168,596 | 1.00 (+1 more) | Oreo Shake [Shakes]; Strawberry Oreo Shake [Shakes] | in-scope name match |
| `images/Shakes/Strawberry Shake.png` | Shakes | JPEG | 939×873 / 84,228 | 1.00 | Strawberry Oreo Shake [Shakes] | in-scope name match |

## (a) Photos with no matching menu item (9)
- `images/Big Bang/Burning Man.jpeg` — nearest candidate Cheese Burst Burger (0.50) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Big Bang/Farm Fresh.jpg` — nearest candidate Mint Fries (0.60) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Classic Burgers/red hot.JPG` — nearest candidate Oreo Shake (0.47) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Cold Coffee/Mocha.jpg` — nearest candidate Lemon Iced Tea (0.42) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Meals/Red Hot meal.jpg` — nearest candidate Make It A Meal (0.62) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/MYOB.png` — nearest candidate Veg Momos (0.31) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Shakes/Biscoff Shake.png` — nearest candidate Oreo Shake (0.61) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Shakes/Cookie Crumble.JPG` — nearest candidate Tandoori Paneer Burger (0.39) below threshold / no informative token overlap; no menu item exists for this dish.
- `images/Shakes/Nutella.JPG` — nearest candidate Lemon Iced Tea (0.38) below threshold / no informative token overlap; no menu item exists for this dish.

## (b) Menu items with no photo (22)
- **Add-Ons**: Cheese Slice, Peri Peri, Make It A Meal
- **Burgers**: American Burger, Gochuchang Burger, Kurkure Momos Burger, Cheese Jalapeño Burger
- **Cold Coffee**: Classic Cold Coffee
- **Combos**: Any Classic Burger Meal
- **Coolers**: Masala Coke, Kokum Iced Tea
- **Shakes**: BlueBerry Shake
- **Sides**: Onion Rings (5 pcs.), Mint Fries
- **Sizzling**: Veg Sizzling Burger, Cheese Supreme Burger, Paneer Supreme Burger
- **Sydney's Viral**: Classic Dipper Burger, Cheese Dipper Burger
- **UFO Burgers**: Galaxy Seal Hero Burger, Orbit X Paneer Burger, Cosmic Lava Cheese Burger

## Duplicate content groups (identical staged bytes)
Same picture stored under several filenames — integrators may want to dedupe or re-shoot; name-based mapping above still applies per filename:
- `images/Beverages/Lemon Iced Tea.jpg` = `images/Beverages/Peach.jpg`
- `images/Big Bang/Great Indian.jpg` = `images/Classic Burgers/Veggie loaded.jpg`
- `images/Big Bang/tandoori paneer.jpg` = `images/Classic Burgers/Mexican.jpg`
- `images/Cold Coffee/Oreo.JPG` = `images/Shakes/Cookie Crumble.JPG` = `images/Shakes/Oreo.JPG`
- `images/Shakes/Chocolate.JPG` = `images/Shakes/Nutella.JPG`

## Notes
- Opaque `*.png` sources were converted to JPEG bytes while keeping the original filename (including extension), per the task's 'convert PNG photos to JPEG' + 'keep original filenames' instructions. No staged image has real transparency, so no PNG-encoded output was required.
- EXIF orientation was baked in before resize (re-encoding drops EXIF).
- `Meals/` photos are combo shots; matches there are cross-category depictions of the individual menu items shown, not combo SKUs (the Combos list has no matching SKU).
