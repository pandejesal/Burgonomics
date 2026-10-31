"use strict";

// Disconnected design sheets only: no app imports, storage, APIs, auth or mutation handlers.
const params = new URLSearchParams(window.location.search);
const state = window.PROPOSED_STATES.find(item => item.key === params.get("screen")) || window.PROPOSED_STATES[0];
const theme = params.get("theme") === "dark" ? "dark" : "light";
const scale = params.get("scale") === "2" ? 2 : 1;
const spacing = params.get("spacing") === "1";
const revision = /^r\d{1,3}$/.test(params.get("revision") || "") ? params.get("revision") : "r0";
const sample = ["320", "768", "390", "320-200", "390-spacing"].includes(params.get("sample")) ? "-" + params.get("sample") : "";
const imageId = state.id + (theme === "light" ? "-L" : "-D") + sample;
Object.assign(document.documentElement.dataset, {theme, textScale: String(scale), spacing: String(spacing), capture: String(params.get("capture") === "1")});

const icons = {
  home: '<path d="m3 10 9-7 9 7v10H4V10Z"/><path d="M9 20v-7h6v7"/>',
  menu: '<path d="M4 3v6c0 2 4 2 4 0V3M6 3v18M15 3v18M15 3c6 2 6 10 0 10"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  bag: '<path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mute: '<path d="M3 9h4l5-4v14l-5-4H3V9ZM17 9l5 6M22 9l-5 6"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17v1"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  up: '<path d="m5 15 7-7 7 7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m4 0h1m4 0h1M6 13h1m4 0h1m4 0h1M7 16h10"/>'
};
function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.warning}</svg>`; }
function button(text, kind = "secondary") { return `<button type="button" class="button ${kind}" aria-disabled="true">${text}</button>`; }
function notice(title, body, kind = "", symbol = "warning") {
  return `<div class="notice ${kind}"><div class="notice-title">${icon(symbol)}<span>${title}</span></div><p class="small">${body}</p></div>`;
}
function identity(partner = false) {
  return `<div class="identity"><img src="assets/mascot.png" alt="Existing Burgonomics mascot"><div><div class="brand-name">Burgonomics</div>${partner ? '<small class="muted">Partner</small>' : ""}</div></div>`;
}
function disclaimer() {
  return `<aside class="proposal" aria-label="Design proposal disclaimer"><strong>PROPOSED — NOT IMPLEMENTED</strong><span>v2-${revision} / ${imageId} / ${theme} / ${window.innerWidth} CSS px / ${scale * 100}% type${spacing ? " / text-spacing study" : ""}</span><span>${state.title}<br>Internal review. Synthetic data. All product controls disconnected.</span></aside>`;
}
function navigation(active) {
  return `<nav class="bottom-nav" aria-label="Existing customer destinations, disconnected">${[["Home", "home"], ["Menu", "menu"], ["Cart", "bag"], ["Profile", "user"]].map(([label, symbol]) => `<button type="button" aria-disabled="true" ${active === label ? 'aria-current="page"' : ""}>${icon(symbol)}<span>${label}</span></button>`).join("")}</nav>`;
}
function reviewTools() {
  const link = (key, mode) => `?screen=${key}&theme=${mode}&revision=${revision}`;
  return `<details class="review-tools"><summary>Tweaks — review views only</summary><p class="small muted">These local links change the proposal, not an app. The product controls above do nothing.</p><div class="links"><a href="${link(state.key, "light")}">Light composition</a><a href="${link(state.key, "dark")}">Dark composition</a></div>${window.PROPOSED_STATES.map(item => `<a href="${link(item.key, theme)}">${item.id} — ${item.title}</a>`).join("")}</details>`;
}
function deliveryShell(title, subtitle, body, active = "Cart", extra = "") {
  return `<div class="artifact ${extra}">${disclaimer()}<header class="brand-bar">${identity()}</header><div class="page-heading"><h1>${title}</h1>${subtitle ? `<p class="small">${subtitle}</p>` : ""}</div><main class="content">${body}</main>${navigation(active)}${reviewTools()}</div>`;
}
function facts(rows) { return `<dl class="facts">${rows.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join("")}</dl>`; }

function shortcut(label, photo, unavailable = false) {
  return `<button type="button" class="shortcut${unavailable ? " unmapped" : ""}" aria-disabled="true"><span class="shortcut-media">${photo ? `<img src="assets/${photo}" alt="Existing ${label.toLowerCase()} photograph">` : '<span class="photo-placeholder">Wraps photo<br>needed</span>'}</span><span class="shortcut-caption">${label}${unavailable ? '<small>Unavailable</small>' : ""}</span></button>`;
}
function home() {
  const unmapped = state.key === "home-unmapped";
  const outletCopy = unmapped ? '<strong>Example selected outlet</strong><small class="muted">Synthetic outlet context · not a live location</small>' : '<strong>Choose an outlet</strong><small class="muted">Set location to see availability</small>';
  return `<div class="artifact">${disclaimer()}<header><div class="brand-bar">${identity()}<button type="button" class="icon-button" aria-disabled="true" aria-label="Notifications, disconnected">${icon("bell")}</button></div><div class="outlet">${icon("pin")}<div>${outletCopy}</div></div><div class="mode-switch" role="group" aria-label="Fulfilment, disconnected">${["Delivery", "Takeaway", "Dine-in"].map((label, index) => `<button type="button" aria-disabled="true" aria-pressed="${index === 0}">${label}</button>`).join("")}</div></header><main class="content"><button type="button" class="search" aria-disabled="true">${icon("search")}<span>Search the menu</span></button><div class="brand-banner">${icon("menu")}<div class="stack"><p>Burgers, sides and something cold.</p><small>Explore the full menu</small></div></div><section><h1 class="section-heading">What are you craving?</h1><div class="shortcut-grid">${shortcut("Burgers", "burger.jpg")}${shortcut("Wraps", null, unmapped)}${shortcut("Sides", "fries.jpg")}${shortcut("Shakes & Drinks", "shake.jpg")}</div></section>${unmapped ? notice("Wraps shortcut unavailable", "We can’t match this shortcut to this outlet’s menu. Browse the full menu; no similar category is selected for you.", "warning") : ""}<p class="rule-note">Four shortcuts; all original menu categories remain. Awards and upcoming-store sections are hidden until approved content exists.</p></main>${navigation("Home")}${reviewTools()}</div>`;
}
function product(name, image, copy) {
  return `<article class="product"><div class="product-copy"><span class="veg-mark"><span class="veg-dot"></span>Vegetarian</span><h3>${name}</h3><p class="small muted">${copy}</p><p class="small muted numeric">₹— · price not quoted</p></div><div class="product-photo"><img src="assets/${image}" alt="Existing ${name.toLowerCase()} photograph"><button type="button" class="add" aria-disabled="true" aria-label="Add ${name}, disconnected">Add +</button></div></article>`;
}
function menu() {
  const boundary = state.key === "menu-boundary";
  let first = product("Hero burger", "burger.jpg", "Illustrative item. Options and current price need validation.");
  let middle = notice("Loading this section", "Products are not loaded yet. Other section headings remain visible.", "", "clock");
  if (state.key === "menu-error") middle = `<div class="stack-wide">${notice("Couldn’t load this section", "The connection failed. Retry this section without replacing the rest of the menu.", "warning")}${button("Retry this section")}</div>`;
  if (state.key === "menu-empty") middle = notice("No items in this section", "This example assumes a successful outlet-scoped query with no products. Other sections are still available.", "", "menu");
  if (boundary) {
    first += '<p class="small muted">End of the loaded Classic burgers section.</p>';
    middle = '<p class="small muted">The next category begins here in the same vertical page. No swipe or tab replacement.</p>';
  }
  const body = `<section><h2>Classic burgers</h2>${first}</section><section class="stack-wide"><h2>Big Bang burgers</h2>${middle}</section><section><h2>French fries</h2>${product("Salted fries", "fries.jpg", "The following section remains in the same document flow.")}</section><p class="rule-note">Illustrative sections, not a live complete catalog. No item counts, prices or global fallback are invented.</p>`;
  return `<div class="artifact menu-shell">${disclaimer()}<header class="brand-bar">${identity()}<button type="button" class="icon-button" aria-label="Search, disconnected" aria-disabled="true">${icon("search")}</button></header><div class="page-heading"><h1>Menu</h1><p class="small">Example outlet context · not a live catalog</p></div><nav class="jump-strip" aria-label="Category jumps, not exclusive tabs">${["Classic burgers", "Big Bang burgers", "French fries"].map((label, index) => `<button type="button" aria-disabled="true" ${index === (boundary ? 1 : 0) ? 'aria-current="true"' : ""}>${label}</button>`).join("")}</nav><main class="content">${body}</main>${navigation("Menu")}${reviewTools()}</div>`;
}
function emptyCart() {
  const returning = state.key === "cart-returning";
  const guest = state.key === "cart-guest";
  const body = `<section class="empty-hero"><div class="empty-icon">${icon("bag")}</div><h2>Your cart is empty.</h2><p class="muted">${guest ? "Browse the menu as a guest. Sign-in is needed only when you continue to checkout." : "Find a favourite or explore something new."}</p>${button("Explore the menu", "primary")}</section>${returning ? `<section class="history"><h2>Order again</h2><p class="small muted">Synthetic history · layout example only</p><div class="history-summary"><img src="assets/burger.jpg" alt="Existing Hero burger photograph"><div class="stack"><h3>Hero burger + Salted fries</h3><p class="small muted">Previous order example</p><p class="small">We’ll check this outlet, stock, options and today’s prices first.</p></div></div>${button("Check items to reorder")}</section>` : `<p class="rule-note">${guest ? "Guest composition: no history read, order history or reorder rail." : "Signed-in, verified no-history composition: reorder is hidden. No invented previous order."}</p>`}`;
  return deliveryShell("Your cart", guest ? "Guest browsing" : "Illustrative signed-in state", body);
}
function reorderReview() {
  return deliveryShell("Review changes", "Synthetic reorder outcome · nothing has been added", `${notice("This order needs a fresh check", "Some items or options are no longer available. We won’t replace them or change your basket without review.", "warning")}<section aria-label="Illustrative reorder changes"><div class="change-row"><h2>Hero burger</h2><span class="change-label">Saved option no longer offered</span><p class="small muted">Choose a currently supported option in the menu; no automatic replacement.</p></div><div class="change-row"><h2>Salted fries</h2><span class="change-label">Unavailable at this outlet</span><p class="small muted">Not eligible to add in this example.</p></div><div class="change-row"><h2>Current price check</h2><span class="change-label">Price changed — review required</span><p class="small muted numeric">New amount: ₹—. This design does not supply a quote or tax total.</p></div></section>${button("Review in menu", "primary")}${button("Add after validation — unavailable", "blocked")}<p class="rule-note">An existing basket stays unchanged until live validation succeeds and any outlet replacement is explicitly confirmed.</p>`);
}
const kitchenNote = "Please keep sauces on the side.";
function cartItem(name, image) {
  return `<article class="cart-item"><img src="assets/${image}" alt="Existing ${name.toLowerCase()} photograph"><div class="cart-item-info"><h3>${name}</h3><p class="small muted numeric">₹— · price needs verification</p><div class="quantity" aria-label="Illustrative quantity"><button type="button" aria-disabled="true" aria-label="Decrease ${name} quantity, disconnected">−</button><span class="numeric">1</span><button type="button" aria-disabled="true" aria-label="Increase ${name} quantity, disconnected">+</button></div></div></article>`;
}
function noteSection(expanded, saved = false) {
  return `<section class="instructions"><button type="button" class="instructions-title" aria-expanded="${expanded}" ${expanded ? 'aria-controls="cooking-note"' : ""} aria-disabled="true"><span>${saved ? "Cooking instructions" : "Add cooking instructions"}</span>${icon(expanded ? "up" : "down")}</button>${expanded ? `<div class="field"><label for="cooking-note" class="small">One note for the kitchen (optional)</label><textarea id="cooking-note" rows="3" readonly maxlength="240" aria-describedby="note-count note-limit">${kitchenNote}</textarea><p id="note-count" class="small muted numeric">${kitchenNote.length} / 240 UTF-16 units</p><p id="note-limit" class="small muted">Current client ceiling; the server/POS limit still needs verification. This preview is read-only.</p></div><p class="small muted">Requests need kitchen confirmation. Allergy accommodation is not guaranteed.</p>` : saved ? `<p class="note-summary">${kitchenNote}</p><p class="small muted">One order-level note. Expand to review or edit in the eventual app.</p>` : '<p class="small muted">Optional. One note for this order, not one field per item.</p>'}</section>`;
}
function bill() {
  return `<section class="bill"><h2>Bill details</h2><p class="small muted">Server-verified prices, tax, fees and eligible discounts belong here. None are invented for this preview.</p><div class="bill-total"><span>Total</span><span class="numeric">₹—</span></div><p class="small muted">No payable amount is available in this design.</p></section>${button("Continue — design preview only", "primary")}`;
}
function cartNote() {
  const expanded = state.key === "note-expanded";
  const saved = state.key === "note-summary";
  return deliveryShell("Your cart", "Example basket · not an order", `<section aria-label="Illustrative cart items">${cartItem("Hero burger", "burger.jpg")}${cartItem("Salted fries", "fries.jpg")}</section>${noteSection(expanded, saved)}${bill()}<p class="rule-note">Reorder is hidden while the cart has items. Delivery drop-off requests are separate; no extra editor is introduced here.</p>`);
}
function keyboardStudy() {
  return `<div class="artifact">${disclaimer()}<header class="brand-bar">${identity()}</header><div class="page-heading"><h1>Cooking instructions</h1><p class="small">Keyboard-space composition, not a native capture</p></div><main class="content keyboard-content"><p class="small muted">Cart context: 2 illustrative items. This content would scroll above the keyboard.</p>${noteSection(true)}${button("Done editing — disconnected")}</main><aside class="keyboard-space" aria-label="Illustrative reserved keyboard area">${icon("keyboard")}<strong>Reserved keyboard space</strong><p class="small muted">Illustration only. No software keyboard is open. Native IME, focus, viewport resize and safe-area behaviour are not tested.</p></aside>${reviewTools()}</div>`;
}
function customerTracking() {
  const escalated = state.key === "tracking-escalated";
  return deliveryShell("Order status", "Example order DESIGN-A · no real order", `${notice(escalated ? "Restaurant confirmation needs attention" : "Payment received. Confirmation pending.", escalated ? "Your payment and restaurant confirmation are separate. The team needs to review this delay; preparation has not been confirmed." : "We’re waiting for the restaurant to confirm your order. Please don’t place or pay for the same order again.", "warning", "clock")}<ol class="progress-list"><li><span class="step-marker">${icon("check")}</span><div class="stack"><strong>Payment captured</strong><span class="small muted">Synthetic payment fact · amount ₹—</span></div></li><li class="current"><span class="step-marker">${icon("clock")}</span><div class="stack"><strong>Awaiting restaurant confirmation</strong><span class="small muted numeric">${escalated ? "05:12" : "02:14"} since capture · example age</span></div></li><li class="future"><span class="step-marker"></span><div class="stack"><strong>Preparation not yet confirmed</strong><span class="small">No KOT confirmation or arrival estimate is available.</span></div></li></ol>${facts([["Support status", escalated ? "Escalated for review at 5 minutes — example" : "Staff alert at 2 minutes — example"], ["Restaurant / POS", "Not confirmed"], ["Refund", "No automatic refund initiated by this state"]])}${button("Contact support", "primary")}<p class="rule-note">Alert/escalation delivery is assumed only for this scenario, not proven. The app must show durable server facts; reconnecting must not resend a payment or POS order.</p>`, "Cart");
}
function partnerHeader(active = "Kitchen KDS", outlet = true) {
  const scope = state.key === "stock-select-outlet";
  const outletCopy = `<div class="partner-outlet"><strong class="small">${scope ? "All Outlets — view only" : "Example permitted outlet"}</strong><span class="fine">${scope ? "Select one outlet to make changes" : "Synthetic scope · no outlet ID"}</span></div>`;
  return `<header class="brand-bar partner-top">${identity(true)}${outlet ? outletCopy : ""}</header><nav class="partner-nav" aria-label="Existing Partner destinations, disconnected">${["Dashboard", "Live Orders", "Kitchen KDS", "Delivery Queue", "Menu Catalog", "Settings"].map(label => `<button type="button" aria-disabled="true" ${label === active ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>`;
}
function operations(title, subtitle, body, active = "Kitchen KDS") {
  return `<div class="artifact operations">${disclaimer()}${partnerHeader(active)}<main class="content ops-content"><div class="ops-heading"><div><h1>${title}</h1><p class="small muted">${subtitle}</p></div></div>${body}<p class="fine">Synthetic operational facts only. No feed, sound, payment, stock, POS, support or courier action is connected.</p></main>${reviewTools()}</div>`;
}
function staffAccess() {
  const signIn = state.key === "staff-sign-in";
  const messages = {
    "access-uninvited": ["Invitation required", "This account has not been granted staff access. Downloading the app does not create a staff role."],
    "access-revoked": ["Your access has been removed", "This session can no longer open staff operations. Ask your Burgonomics administrator to review your access."],
    "access-branch": ["This outlet isn’t in your access", "Choose an outlet you are authorised to use, or contact your administrator. No records from the denied outlet are shown."]
  };
  const [title, description] = messages[state.key] || ["For your restaurant team.", "Sign in with the staff account invited by Burgonomics."];
  return `<div class="artifact">${disclaimer()}<header class="brand-bar">${identity(true)}</header><main class="content sign-in"><div class="empty-icon">${icon("lock")}</div><div class="stack-wide"><h1>${title}</h1><p class="muted">${description}</p></div>${signIn ? `${notice("Access is by invitation", "No public registration, role picker or demo account. Use the existing approved staff sign-in flow.", "", "user")}<div class="field"><label for="staff-account">Invited staff account</label><input id="staff-account" type="text" placeholder="Approved account · read-only preview" readonly autocomplete="off"></div>${button("Continue — design preview only", "primary")}` : `${notice("Operations are unavailable", "No cached orders, customer details or unauthorised outlet records appear in this denial composition.", "warning", "lock")}${button(state.key === "access-branch" ? "Choose a permitted outlet" : "Back to staff sign-in", "primary")}` }<p class="rule-note">Need access? Contact your Burgonomics administrator. This is a disconnected support instruction, not a new contact channel or a working login.</p></main><footer class="support-note">No credential collection or account action. Server enforcement, cache clearing and revocation behaviour still require testing.</footer>${reviewTools()}</div>`;
}
function pendingTicket(age = "00:48", escalated = false) {
  return `<article class="ticket urgent"><div class="ticket-header"><h3>Example DESIGN-A</h3><span class="small muted">Takeaway</span></div>${facts([["Payment", "Captured — synthetic fact, ₹—"], ["POS transport", "Acknowledgement unconfirmed"], ["Restaurant acceptance", "Not confirmed"], ["Age since capture", `<span class="numeric">${age} — example</span>`]])}<div class="ticket-lines"><span>1 × Hero burger</span><span>1 × Salted fries</span></div><p class="ticket-note">Kitchen note: ${kitchenNote}</p><p class="small muted">${escalated ? "5-minute escalation reached. Preserve attempt identity; outcome is uncertain." : age === "02:14" ? "2-minute staff alert reached. Escalate at 5 minutes if unresolved." : "Not yet at the 2-minute staff-alert threshold."}</p>${button("Review confirmation", "primary")}</article>`;
}
function preparingTicket(stale = false) {
  return `<article class="ticket"><div class="ticket-header"><h3>Example DESIGN-B</h3><span class="small muted">Takeaway</span></div>${facts([["Tender", "External cash — not a Razorpay receipt"], ["Restaurant state", stale ? "Last confirmed: preparing" : "Preparing — synthetic confirmed state"], ["Snapshot", stale ? "Stale; revalidate before any action" : "Current in this scenario only"]])}<div class="ticket-lines"><span>1 × Hero burger</span></div>${button(stale ? "View last confirmed details" : "View order details")}<p class="small muted">${stale ? "Old actions are not replayed on resume. Terminal orders must not return." : "No fulfilment or acceptance action is connected."}</p></article>`;
}
function health(label, age, sound = "Visual alerts remain visible", current = false) {
  return `<div class="health"><span class="status ${current ? "current" : "warning"}">${icon(current ? "check" : "warning")}<span>${label}</span></span><span class="status">${icon("clock")}<span>${age}</span></span><span class="status">${icon("bell")}<span>${sound}</span></span></div>`;
}
function kds() {
  const key = state.key;
  let body;
  if (key === "kds-loading") {
    body = `${health("Connecting to authorised feed", "No snapshot yet")}${notice("Loading orders", "The kitchen state is not known yet. Missing data does not mean no orders.", "", "clock")}<div class="lane-grid" aria-label="Static loading placeholders"><div class="skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div><div class="skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line"></span></div></div>`;
  } else if (key === "kds-empty") {
    body = `${health("Authorised feed current — example", "Last successful snapshot: 8 seconds ago", "No sound claim in this preview", true)}<section class="feed-empty"><div class="empty-icon">${icon("check")}</div><h2>No orders in this queue</h2><p class="muted">This scenario assumes a successful, authorised query for this outlet and queue. It is not a claim about all outlets, revenue or the whole kitchen.</p></section>`;
  } else if (["kds-reconnecting", "kds-error", "kds-offline"].includes(key)) {
    const description = {
      "kds-reconnecting": ["Reconnecting", "Keep the last safe snapshot visible. Do not accept or replay a change until the server state is current."],
      "kds-error": ["Live updates unavailable", "A listener or required index failed. This is not an empty queue. Reconnect or ask an authorised administrator to investigate."],
      "kds-offline": ["Offline — showing stale orders", "On resume, refresh server state before applying any pending change. Do not resurrect a terminal order or blindly replay an old action."]
    }[key];
    body = `${health(description[0], "Last good snapshot: 38 seconds ago")}${notice(description[0], description[1], "warning")}<div class="lane-grid"><section class="lane"><h2>Last safe snapshot</h2>${preparingTicket(true)}</section><section class="lane"><h2>Connection recovery</h2><p class="small muted">Order freshness is unknown. A one-shot refresh must not be labelled as a live feed.</p>${button(key === "kds-offline" ? "Check connection" : "Reconnect feed")}</section></div>`;
  } else {
    const muted = key === "kds-muted";
    const blocked = key === "kds-audio-blocked";
    const age = muted || blocked ? "02:14" : "00:48";
    body = `${health("Authorised feed current — example", "Last snapshot: 8 seconds ago", muted ? "Sound muted; visual alert active" : blocked ? "Sound unavailable; visual alert active" : "Sound availability is a separate fact", true)}${muted || blocked ? `<div class="stack-wide">${notice(muted ? "Sound is muted" : "Sound needs attention", blocked ? "Audio could not start or notification permission is blocked. Keep this visual warning; use the appropriate device setting or audio-unlock action." : "New pending orders remain visually highlighted. Acknowledging this alert does not accept an order.", "warning", "mute")}${button(blocked ? "Review sound and permissions" : "Unmute alerts")}</div>` : ""}<div class="lane-grid"><section class="lane"><h2>Needs confirmation</h2>${pendingTicket(age)}</section><section class="lane"><h2>Preparing</h2>${preparingTicket()}</section></div>${muted || blocked ? button("Acknowledge alert only") : '<p class="rule-note">A new order can arrive while another leaves with the same queue count. This static sheet does not test alert identity or delivery.</p>'}`;
  }
  return operations("Kitchen display", "Outlet-scoped operational state study", body);
}
function ordersOrPos() {
  const escalated = state.key === "pos-escalated";
  const orders = state.key === "orders-pending";
  const title = orders ? "Live orders" : "Restaurant confirmation";
  const alert = orders ? notice("Needs restaurant confirmation", "A captured payment is not a confirmed KOT. Review the unresolved order before taking a fulfilment action.", "warning", "clock") : notice(escalated ? "5-minute escalation — review required" : "2-minute staff alert", escalated ? "The send outcome is uncertain. Do not send a second POS order or refund automatically to clear this warning." : "Restaurant acceptance is still unconfirmed. Alert acknowledgement must not mark the order accepted.", "warning", "clock");
  return operations(title, "Payment, transport and restaurant facts are independent", `${alert}<div class="detail-grid"><section class="lane"><h2>Unresolved order</h2>${pendingTicket(escalated ? "05:12" : "02:14", escalated)}</section><section class="stack-wide"><h2>${orders ? "Operational checks" : "Reconciliation"}</h2>${facts([["Attempt reference", "DESIGN-ATTEMPT-A — synthetic"], ["Transport certainty", "Unknown; provider acknowledgement not confirmed"], ["KOT evidence", "None confirmed in this scenario"], ["Alert threshold", "Staff at 2 minutes; escalate at 5 minutes"]])}${notice("Preserve the attempt identity", "An authorised operator must reconcile the existing attempt. No generic retry-send action is offered.", "", "lock")}${button("Open reconciliation record")}${button("Acknowledge alert only")}<p class="small muted">No automatic refund, blind resend or payment replay. Durable alert delivery and operator evidence remain unverified.</p></section></div>`, orders ? "Live Orders" : "Kitchen KDS");
}
function stock() {
  const denied = state.key === "stock-save-denied";
  const scope = state.key === "stock-select-outlet";
  const panel = scope ? `<h2>Select an outlet</h2>${notice("All Outlets is view-only", "Choose exactly one permitted outlet before changing an item’s availability. No mutation scope is inferred.", "warning", "lock")}${button("Choose one permitted outlet", "primary")}` : `<h2>Item availability</h2><div class="stock-item"><img src="assets/fries.jpg" alt="Existing Salted fries photograph"><div class="stack"><h3>Salted fries</h3><p class="small muted">Example permitted outlet only</p></div></div>${[ ["Backend save", denied ? "Denied — last confirmed value unchanged" : "Saved: unavailable — example"], ["Customer-facing propagation", denied ? "No update confirmed" : "Not yet verified in customer view"], ["Petpooja stock sync", denied ? "Not attempted after denied save" : "Failed — reconciliation required"] ].map(([label, value]) => `<div class="stock-fact"><span class="label">${label}</span><span class="value">${value}</span></div>`).join("")}${button(denied ? "Change unavailable — permission denied" : "Unavailable — backend saved", "blocked")}${button(denied ? "Review access with administrator" : "Review POS sync failure", "primary")}`;
  return operations("Menu availability", scope ? "Scope guard before any stock change" : "Save status is separate from customer and POS confirmation", `<div class="detail-grid"><section class="stack-wide"><h2>${scope ? "All Outlets — view only" : "Availability change"}</h2>${notice(scope ? "One outlet is required" : denied ? "Stock change wasn’t saved" : "Saved here. POS sync failed.", scope ? "There is no selected permitted outlet for this action." : denied ? "You don’t have permission to save this change. Keep the last confirmed availability; do not show an optimistic success." : "The backend value changed in this scenario. Customer propagation and the POS result are separate facts, not one green toast.", "warning")}<p class="small muted">No POS item ID or combo mapping is invented. App-only items must not be presented as synchronised to Petpooja.</p><p class="rule-note">Last safe facts remain visible. Only an authorised server operation may reconcile a failure; the client must not overwrite uncertainty.</p></section><aside class="side-panel" aria-label="Availability drawer composition, not an open modal">${panel}</aside></div>`, "Menu Catalog");
}
function dispatch() {
  const uncertain = state.key === "dispatch-uncertain";
  return operations("Delivery queue", "Example request for one permitted outlet; no rider assigned", `${notice(uncertain ? "Booking outcome uncertain" : "Booking request rejected", uncertain ? "The request timed out before its outcome was confirmed. Preserve its identity and reconcile it before booking again or changing providers." : "This scenario assumes a confirmed provider rejection. It is different from a timeout with an unknown outcome.", "warning")}<div class="detail-grid"><section class="stack-wide"><h2>Request DESIGN-REQUEST-A</h2>${facts([["Provider", "Borzo — illustrative request only"], ["Request reference", "DESIGN-REQUEST-A — synthetic, retained"], ["Booking ID", uncertain ? "Not confirmed; do not invent an ID" : "No booking created in this confirmed-rejection scenario"], ["Fare", "₹— · no verified quote"], ["Rider / tracking", "Not confirmed; no simulated rider"]])}${button(uncertain ? "Reconcile existing request" : "Review service options", "primary")}</section><aside class="side-panel"><h2>${uncertain ? "Do not create a duplicate" : "Choose a supported next step"}</h2><p class="small muted">${uncertain ? "A second Borzo booking, Shadowfax fallback or manual assignment must wait for certainty about this request." : "Recheck supported service, current quote and permission before any new attempt. A manual tender is not a Razorpay receipt."}</p>${button(uncertain ? "New booking blocked pending review" : "Booking disabled in this preview", "blocked")}<p class="small muted">Shadowfax availability and manual-assignee contracts still need owner evidence. No retired provider is restored here.</p></aside></div>`, "Delivery Queue");
}
function appearance() {
  const partner = state.app === "Partner";
  const body = `<section class="stack-wide"><h2>Appearance</h2><p class="muted">Choose how the app looks on this device.</p><div class="choices" role="radiogroup" aria-label="Appearance options, static preview">${[["System", "Follow the device’s light or dark appearance."], ["Light", "Keep a white canvas."], ["Dark", "Keep a black canvas."]].map(([name, copy], index) => `<button type="button" class="choice" role="radio" aria-checked="${index === 0}" aria-disabled="true"><span class="choice-copy"><strong>${name}</strong><span class="small muted">${copy}</span></span><span class="radio-mark" aria-hidden="true"></span></button>`).join("")}</div></section>${notice(`System → ${theme === "dark" ? "Dark" : "Light"} in this composition`, "System is selected for illustration. A saved preference, actual OS change, cold start and first paint are not demonstrated.", "", "user")}<p class="rule-note">${partner ? "The same choice must apply inside and outside administration. A remote staff-account preference is not required." : "Available while browsing as a guest. Theme choice must not require sign-in or alter cart/auth data."}</p>`;
  return partner ? `<div class="artifact">${disclaimer()}${partnerHeader("Settings")}<div class="page-heading"><h1>Settings</h1></div><main class="content">${body}</main>${reviewTools()}</div>` : deliveryShell("Settings", "Guest entry · local preference proposal", body, "Profile");
}

const render = state.key.startsWith("home") ? home
  : state.key.startsWith("menu-") ? menu
  : state.key.startsWith("cart-") ? emptyCart
  : state.key === "reorder-review" ? reorderReview
  : state.key === "note-keyboard" ? keyboardStudy
  : state.key.startsWith("note-") ? cartNote
  : state.key.startsWith("tracking-") ? customerTracking
  : state.key.endsWith("appearance") ? appearance
  : state.group === "access" ? staffAccess
  : state.group === "feed" ? kds
  : state.group === "orders-pos" ? ordersOrPos
  : state.key.startsWith("stock-") ? stock
  : dispatch;
document.getElementById("app").innerHTML = render();
document.title = `Burgonomics v2-${revision} / ${imageId} / proposed, not implemented`;
window.PROPOSED_CURRENT = {id: imageId, state: state.key, theme, scale, spacing, revision};
// Compose the selected destination visibly without reordering or hiding destinations.
// This is local sheet positioning, not a test of app navigation/category scrolling.
window.PROPOSED_NAV_READY = false;
document.fonts.ready.then(() => {
  document.querySelectorAll(".partner-nav,.jump-strip").forEach(rail => {
    const selected = rail.querySelector('[aria-current="page"],[aria-current="true"]');
    if (!selected) return;
    const box = selected.getBoundingClientRect();
    const container = rail.getBoundingClientRect();
    if (box.left < container.left + 12 || box.right > container.right - 12) {
      rail.scrollLeft += box.left - container.left - 16;
    }
  });
  window.PROPOSED_NAV_READY = true;
});
