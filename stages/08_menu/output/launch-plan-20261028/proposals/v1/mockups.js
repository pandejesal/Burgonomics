"use strict";

// Isolated static design content. No app imports, auth, storage, API or submit handlers.
const proposalParams = new URLSearchParams(window.location.search);
const proposalTheme = proposalParams.get("theme") === "dark" ? "dark" : "light";
const proposalScreen = ["home", "menu", "cart-empty", "cart-note", "kds", "sign-in"].includes(proposalParams.get("screen"))
  ? proposalParams.get("screen") : "home";
document.documentElement.dataset.theme = proposalTheme;
document.documentElement.dataset.textScale = proposalParams.get("scale") === "2" ? "2" : "1";

const proposalIcons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 3v6c0 2 4 2 4 0V3M6 3v18M15 3v18M15 3c6 2 6 10 0 10"/>',
  bag: '<path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  up: '<path d="m5 15 7-7 7 7"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-5-6L5 21"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mute: '<path d="m3 9 4 0 5-4v14l-5-4H3V9ZM17 9l5 6M22 9l-5 6"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17v1"/>',
};

function proposalIcon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${proposalIcons[name] || proposalIcons.next}</svg>`;
}

function proposalLabel(id, description) {
  const variant = ["320", "768", "320-200"].includes(proposalParams.get("case")) ? "-" + proposalParams.get("case") : "";
  return `<aside class="proposal" aria-label="Design proposal disclaimer"><strong>PROPOSED — NOT IMPLEMENTED</strong><span>${id}${variant} · v0 · ${description}<br>Internal review. Example data; no live services.</span></aside>`;
}

function proposalIdentity(partner = false) {
  return `<div class="identity"><img src="assets/mascot.png" alt="Existing Burgonomics mascot"><div><div class="brand-name">Burgonomics</div>${partner ? '<small class="muted">Partner</small>' : ""}</div></div>`;
}

function proposalHeader() {
  return `<header><div class="brand-bar">${proposalIdentity()}<button type="button" class="icon-button" aria-label="Notifications, static preview" aria-disabled="true">${proposalIcon("bell")}</button></div><div class="outlet">${proposalIcon("pin")}<div><strong>Choose an outlet</strong><small>Set location to see availability</small></div>${proposalIcon("down")}</div><div class="mode-switch" role="group" aria-label="Fulfilment mode, static design"><button type="button" aria-pressed="true" aria-disabled="true">Delivery</button><button type="button" aria-pressed="false" aria-disabled="true">Takeaway</button><button type="button" aria-pressed="false" aria-disabled="true">Dine-in</button></div></header>`;
}

function proposalNavigation(active) {
  return `<nav class="bottom-nav" aria-label="Existing customer navigation, static preview">${[["Home", "home"], ["Menu", "menu"], ["Cart", "bag"], ["Profile", "user"]].map(([name, icon]) => `<button type="button" aria-disabled="true" ${name === active ? 'aria-current="page"' : ""}>${proposalIcon(icon)}<span>${name}</span></button>`).join("")}</nav>`;
}

function proposalCategory(name, source) {
  const media = source ? `<img src="assets/${source}" alt="Existing ${name.toLowerCase()} photograph">` : `<div class="photo-placeholder">${proposalIcon("photo")}Approved wrap<br>photo needed</div>`;
  return `<button type="button" class="category" aria-disabled="true"><span class="category-media">${media}</span><span class="category-caption"><span>${name}</span>${proposalIcon("next")}</span></button>`;
}

function proposalHome() {
  const id = proposalTheme === "dark" ? "D02" : "D01";
  return `<div class="shell">${proposalLabel(id, "Home / " + proposalTheme)}${proposalHeader()}<main class="content"><button type="button" class="search" aria-disabled="true">${proposalIcon("search")}<span>Search the menu</span></button><div class="brand-banner">${proposalIcon("menu")}<div><p>Burgers, sides and<br>something cold.</p><small class="muted">Explore the full menu</small></div></div><section><div class="section-head"><h1>What are you craving?</h1></div><div class="category-grid">${proposalCategory("Burgers", "burger.jpg")}${proposalCategory("Wraps", null)}${proposalCategory("Sides", "fries.jpg")}${proposalCategory("Shakes & Drinks", "shake.jpg")}</div></section><p class="section-note">Four shortcuts. The full menu keeps all its categories.</p></main>${proposalNavigation("Home")}</div>`;
}

function proposalProduct(name, image, copy) {
  return `<article class="product"><div class="product-copy"><span class="veg-mark"><span class="veg-dot"></span>Vegetarian</span><h3>${name}</h3><p class="small">${copy}</p><p class="small numeric">Price pending verification</p></div><div class="product-photo"><img src="assets/${image}" alt="Existing ${name.toLowerCase()} photo"><button type="button" class="add" aria-disabled="true" aria-label="Add ${name}, static preview">Add +</button></div></article>`;
}

function proposalMenu() {
  return `<div class="shell menu-shell">${proposalLabel("D03", "Continuous menu / light")}<div class="brand-bar">${proposalIdentity()}<button type="button" class="icon-button" aria-label="Search, static preview" aria-disabled="true">${proposalIcon("search")}</button></div><div class="page-heading"><h1>Menu</h1><p class="small">Illustrative sections, not a live catalog</p></div><nav class="jump-strip" aria-label="Category jumps, not exclusive tabs"><button type="button" aria-current="true" aria-disabled="true">Classic burgers</button><button type="button" aria-disabled="true">Big Bang burgers</button><button type="button" aria-disabled="true">French fries</button></nav><main class="content"><section><h2>Classic burgers</h2>${proposalProduct("Hero burger", "burger.jpg", "Existing food image. Current options appear here after validation.")}</section><section><h2>Big Bang burgers</h2><p class="notice">Section loading example. A failed section keeps its heading and a retry explanation.</p></section><section><h2>French fries</h2>${proposalProduct("Salted fries", "fries.jpg", "This section follows naturally. No swipe or category replacement.")}</section><p class="section-note">Other real categories continue below. No fabricated item counts or prices.</p></main>${proposalNavigation("Menu")}</div>`;
}

function proposalEmptyCart() {
  return `<div class="shell">${proposalLabel("D04", "Empty Cart / returning-user example")}<div class="brand-bar">${proposalIdentity()}</div><div class="page-heading"><h1>Your cart</h1></div><main class="content"><section class="empty-hero"><div class="empty-icon">${proposalIcon("bag")}</div><h2>Something good starts here.</h2><p class="muted">Your cart is empty. Find a favourite or explore something new.</p><button type="button" class="button primary" aria-disabled="true">Explore the menu</button></section><section class="history"><h2>Order again</h2><p class="small muted">Synthetic history for layout review only</p><div class="history-summary"><img src="assets/burger.jpg" alt="Existing Hero burger photo"><div class="stack"><h3>Hero burger + Salted fries</h3><p class="small muted">Example previous order</p><p class="small">Check today's outlet, availability and prices before adding.</p></div></div><button type="button" class="button secondary" aria-disabled="true">Check items to reorder</button></section><p class="section-note">Reorder appears only when this cart is empty. Guest/no-history versions hide it.</p></main>${proposalNavigation("Cart")}</div>`;
}

function proposalCartItem(name, image) {
  return `<article class="cart-item"><img src="assets/${image}" alt="Existing ${name.toLowerCase()} photo"><div class="cart-item-info"><h3>${name}</h3><p class="small muted">Price pending verification</p><div class="quantity" aria-label="Example quantity"><button type="button" aria-label="Decrease quantity, static preview" aria-disabled="true">−</button><span class="numeric">1</span><button type="button" aria-label="Increase quantity, static preview" aria-disabled="true">+</button></div></div></article>`;
}

function proposalCartNote() {
  return `<div class="shell">${proposalLabel("D05", "Cart / one expanded cooking note / dark")}<div class="brand-bar">${proposalIdentity()}</div><div class="page-heading"><h1>Your cart</h1><p class="small">Illustrative basket · not an order</p></div><main class="content"><section aria-label="Example cart items">${proposalCartItem("Hero burger", "burger.jpg")}${proposalCartItem("Salted fries", "fries.jpg")}</section><section class="instructions"><button type="button" class="instructions-title" aria-expanded="true" aria-controls="cooking-note" aria-disabled="true"><span>Add cooking instructions</span>${proposalIcon("up")}</button><label for="cooking-note" class="small muted">One note for the kitchen (optional)</label><textarea id="cooking-note" readonly rows="3">Please keep sauces on the side.</textarea><p class="small muted">Example note. Requests are subject to kitchen confirmation; allergy accommodation is not guaranteed.</p></section><section class="bill"><h2>Bill details</h2><p class="small muted">The server-verified bill belongs here. Tax, fees and discounts are not invented for this mockup.</p><div class="bill-total"><span>Total</span><span class="numeric">₹—</span></div><p class="small muted">Verified price unavailable in this design preview.</p></section><button type="button" class="button primary" aria-disabled="true">Continue · design preview only</button></main>${proposalNavigation("Cart")}</div>`;
}

function proposalTicket(id, urgent) {
  const facts = urgent ? `<div><dt>Payment</dt><dd>Captured — example only</dd></div><div><dt>Restaurant / POS</dt><dd>Awaiting confirmation</dd></div><div><dt>Elapsed since capture</dt><dd class="numeric">02:14 — staff alert due</dd></div>` : `<div><dt>Payment</dt><dd>External cash — example only</dd></div><div><dt>Restaurant / POS</dt><dd>Last confirmed: preparing</dd></div><div><dt>Freshness</dt><dd>Snapshot is stale; revalidate</dd></div>`;
  return `<article class="ticket ${urgent ? "urgent" : ""}"><div class="ticket-header"><h3>Example ${id}</h3><span class="small muted">Takeaway</span></div><dl class="ticket-facts">${facts}</dl><div class="ticket-lines"><span>1 × Hero burger</span><span>1 × Salted fries</span></div><p class="ticket-note">Kitchen note: Please keep sauces on the side.</p>${urgent ? '<p class="small muted">Escalate at 5 minutes if unresolved. No blind resend or automatic refund.</p><button type="button" class="button primary" aria-disabled="true">Review confirmation</button>' : '<p class="small muted">No state change until the server confirms this order is still current.</p><button type="button" class="button secondary" aria-disabled="true">View last confirmed details</button>'}</article>`;
}

function proposalKds() {
  return `<div class="partner-shell">${proposalLabel("P01", "Partner KDS / stale + muted examples / dark")}<header class="partner-top">${proposalIdentity(true)}<div><strong class="small">Demo outlet — design only</strong><p class="small muted">Permitted outlet selector</p></div></header><nav class="partner-nav" aria-label="Subset of existing Partner destinations, static preview"><button type="button" aria-disabled="true">Dashboard</button><button type="button" aria-disabled="true">Live Orders</button><button type="button" aria-current="page" aria-disabled="true">Kitchen KDS</button><button type="button" aria-disabled="true">Delivery Queue</button><button type="button" aria-disabled="true">Menu Catalog</button><button type="button" aria-disabled="true">Settings</button></nav><main class="kds-content"><div class="kds-heading"><div class="stack"><h1>Kitchen display</h1><p class="muted">Resolve uncertainty before taking action.</p></div><span class="status warning">${proposalIcon("warning")}Live updates unavailable</span></div><div class="health"><span class="status">${proposalIcon("clock")}Last update: 38 seconds ago</span><span class="status">${proposalIcon("mute")}Sound muted — visual alerts remain</span></div><div class="lane-grid"><section><h2>Needs confirmation</h2>${proposalTicket("P-01", true)}</section><section><h2>Preparing</h2>${proposalTicket("P-02", false)}</section></div><p class="review-footnote">Synthetic tickets, payment states and times. No live feed, sound, payment, POS or acknowledgement action is connected.</p></main></div>`;
}

function proposalSignIn() {
  return `<div class="shell">${proposalLabel("P02", "Partner sign-in / invitation-only / light")}<main class="sign-in">${proposalIdentity(true)}<div class="stack"><h1>For your<br>restaurant team.</h1><p class="muted">Sign in with your invited staff account.</p></div><p class="notice">Access is by invitation from Burgonomics. Downloading the app does not grant staff access.</p><div class="field"><label for="staff-account">Invited account</label><input id="staff-account" type="text" value="" placeholder="Your approved staff account" readonly></div><button type="button" class="button primary" aria-disabled="true">Continue · design preview only</button><p class="small muted">Not invited or access removed? Contact your Burgonomics administrator.</p><p class="section-note">Sign-in method and access must follow the existing approved auth flow; no public registration or role selection.</p></main><footer class="sign-in-footer">No working login, account creation or credential collection is present in this mockup.</footer></div>`;
}

const proposalRenderers = { home: proposalHome, menu: proposalMenu, "cart-empty": proposalEmptyCart, "cart-note": proposalCartNote, kds: proposalKds, "sign-in": proposalSignIn };
document.getElementById("app").innerHTML = proposalRenderers[proposalScreen]();
document.title = `Burgonomics proposed v0 — ${proposalScreen} — not implemented`;
