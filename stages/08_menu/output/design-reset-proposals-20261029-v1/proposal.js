// Standalone proposal only. No app imports, storage, authentication or API calls.
const icon = (name, extra = "") => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true"><use href="./assets/icons.svg#${name}"></use></svg>`;
const image = (name, alt, extra = "") => `<img src="./assets/${name}" alt="${alt}" class="${extra}" loading="eager">`;
const brand = () => `<div class="brand-lockup">${image("brand/logo.png", "Burgonomics mascot")}<strong>BURGONOMICS</strong></div>`;
const veg = () => `<span class="veg-label"><span class="veg-mark" aria-hidden="true"></span>Pure veg</span>`;
const demoButton = (label, className = "secondary-button", symbol = "") => `<button type="button" class="${className}" data-demo>${symbol ? icon(symbol) : ""}${label}</button>`;
const navigation = (active) => `<nav class="mobile-nav" aria-label="${active} proposal navigation">${[
  ["home", "home", "Home"], ["menu", "menu", "Menu"], ["cart", "bag", "Cart"], ["profile", "profile", "Profile"],
].map(([key, symbol, title]) => `<button type="button" ${key === active ? 'aria-current="page"' : ""} ${key === "home" || key === "menu" || key === "cart" ? `data-go="${key === "cart" ? "menu" : key}"` : "data-demo"}>${icon(symbol)}<span>${title}</span></button>`).join("")}</nav>`;
const railProduct = (photo, name, price, detail = "") => `<div class="rail-card"><div class="rail-image">${image(`food/${photo}`, name)}</div><h3>${name}</h3>${detail ? `<p class="food-detail">${detail}</p>` : ""}<div class="rail-price"><strong>₹${price}</strong><button type="button" class="small-add" aria-label="Add ${name} — design sample" data-demo>${icon("plus")}</button></div></div>`;

const upcoming = [
  ["Gor Dhod Road", "Surat"], ["Vallabh Vidhyanagar", "Anand"],
  ["Hinjawadi Phase 2", "Pune"], ["Patan", "Gujarat"],
  ["Chandra Park", "Rajkot"], ["Ghatlodiya", "Ahmedabad"],
  ["Mehsana", "Gujarat"], ["Tin Batti", "Daman"],
];

document.querySelector("#home-proposal").innerHTML = `
  <div class="app-scroll">
    <header class="app-header">
      <div class="brand-row">${brand()}<button class="icon-button" aria-label="Search — proposed" data-demo>${icon("search")}</button></div>
      <div class="location-row"><button data-demo><div><small>Your outlet</small><strong>Burgonomics Gota</strong></div>${icon("down")}</button>${veg()}</div>
      <div class="mode-row" role="group" aria-label="Proposed fulfilment choice"><button aria-pressed="true" data-mode>Delivery</button><button aria-pressed="false" data-mode>Takeaway</button><button aria-pressed="false" data-mode>Dine-in</button></div>
    </header>
    <div class="home-content">
      <section class="food-hero" aria-labelledby="hero-title"><h2 class="hero-title" id="hero-title">Damn good<br>burgers.</h2><div class="hero-image">${image("food/hero.jpg", "Burgonomics Super Hero Burger, actual brand photography")}</div><div class="hero-caption"><div><p>The Big Bang Series</p><small>A bigger bite of Burgonomics.</small></div><button class="primary-button" data-go="menu">Explore burgers</button></div></section>
      <section class="home-section" aria-labelledby="shortcuts-heading"><div class="section-heading"><h2 id="shortcuts-heading">On the menu</h2></div>
        <div class="shortcut-grid">
          <button class="category" data-go="menu" aria-label="Burgers">${image("food/burgers.jpg", "")}<span class="category-copy">Burgers</span></button>
          <button class="category unavailable" disabled aria-label="Wraps — not listed at this outlet"><span class="category-copy">Wraps<small>Not listed at Gota</small></span></button>
          <button class="category" data-go="menu" aria-label="Sides">${image("food/fries.jpg", "")}<span class="category-copy">Sides</span></button>
          <button class="category" data-go="menu" aria-label="Shakes & Drinks">${image("food/shake.jpg", "")}<span class="category-copy">Shakes &amp; Drinks</span></button>
        </div>
      </section>
      <section class="home-section" aria-labelledby="bestsellers-heading"><div class="section-heading"><h2 id="bestsellers-heading">Bestsellers</h2><button class="text-link" data-go="menu">View menu</button></div><div class="food-rail" aria-label="Proposed bestseller selection">${railProduct("cheese-burst.jpg", "Cheese Burst Burger", "199")}${railProduct("hero.jpg", "Super Hero Burger", "219")}${railProduct("great-indian.jpg", "Great Indian Burger", "169")}</div></section>
      <section class="home-section" aria-labelledby="combos-heading"><div class="section-heading"><h2 id="combos-heading">Make it a meal</h2><button class="text-link" data-go="menu">View combos</button></div><div class="food-rail combo-rail" aria-label="Combo meals">${railProduct("big-bang-meal.jpg", "Any Big Bang Burger Meal", "299", "Big Bang Burger + Fries + Coke")}${railProduct("classic-meal.jpg", "Any Classic Burger Meal", "199", "Classic Burger + Fries + Coke")}</div></section>
      <section class="awards" aria-labelledby="awards-heading"><div class="awards-body"><h2 id="awards-heading">Awards &amp;<br>Recognition</h2><div class="awards-rule" aria-hidden="true"></div></div>${image("brand/ceremony.webp", "Burgonomics team receiving the Food Connoisseurs India Awards 2026", "awards-image")}<div class="awards-body"><div class="award-row"><h3>Iconic Burger</h3><p><span class="year">2025</span>Times Hospitality Icons</p></div><div class="award-row"><h3>Best Quick Service Restaurant Chain</h3><p><span class="year">2026</span>Food Connoisseurs India Awards</p></div><div class="award-row"><h3>Best Burger Joint</h3><p><span class="year">2026</span>Food Connoisseurs India Awards</p></div></div></section>
      <section class="home-section upcoming" aria-labelledby="upcoming-heading"><div class="section-heading"><h2 id="upcoming-heading">Upcoming Stores</h2></div><p class="section-intro">Announced locations. Opening dates unconfirmed.</p><div class="store-announcements">${upcoming.map(([name, city]) => `<div class="announced-store"><h3>${name}</h3><p>${city}</p></div>`).join("")}</div></section>
    </div>
  </div>${navigation("home")}`;

const menuProduct = (photo, name, price) => `<div class="menu-product">${image(`food/${photo}`, name, "menu-photo")}${veg()}<h4>${name}</h4><div class="product-price"><strong>₹${price}</strong><button class="add-label" aria-label="Add ${name} — design sample" data-demo>Add +</button></div></div>`;
document.querySelector("#menu-proposal").innerHTML = `
  <div class="app-scroll" id="menu-scroll">
    <header class="mobile-page-header"><button class="icon-button" aria-label="Home proposal" data-go="home">${icon("left")}</button><div><h2>Menu</h2><p>Burgonomics Gota</p></div><button class="icon-button" aria-label="Search menu — proposed" data-demo>${icon("search")}</button></header>
    <nav class="category-chips" aria-label="Continuous menu section jumps"><a class="active" href="#proposal-burgers" data-jump="proposal-burgers">Big Bang Burgers</a><a href="#proposal-pasta" data-jump="proposal-pasta">Pasta</a><button class="add-label" data-demo>Shakes</button><button class="add-label" data-demo>Sides</button></nav>
    <section class="menu-section" id="proposal-burgers"><header><h3>Big Bang Burgers</h3></header><div class="menu-grid">${menuProduct("cheese-burst.jpg", "Cheese Burst Burger", "199")}${menuProduct("hero.jpg", "Super Hero Burger", "219")}${menuProduct("great-indian.jpg", "Great Indian Burger", "169")}${menuProduct("tandoori-paneer.jpg", "Tandoori Paneer Burger", "209")}</div></section>
    <section class="menu-section" id="proposal-pasta"><header><h3>Pasta</h3></header><div class="menu-grid">${menuProduct("pink-pasta.jpg", "Pink Sauce Pasta", "199")}${menuProduct("white-pasta.jpg", "White Sauce Pasta", "199")}</div></section>
    <p class="menu-more">Layout excerpt. The other real outlet categories continue in the same vertical flow; chips jump to sections rather than replace them.</p>
  </div>${navigation("menu")}`;

const cartLine = (photo, name, price) => `<div class="cart-line">${image(`food/${photo}`, name)}<div>${veg()}<h3>${name}</h3><div class="cart-line-bottom"><strong>₹${price}</strong><div class="quantity"><button aria-label="Decrease ${name} — sample only" data-demo>${icon("minus")}</button><span>1</span><button aria-label="Increase ${name} — sample only" data-demo>${icon("plus")}</button></div></div></div></div>`;
document.querySelector("#cart-proposal").innerHTML = `
  <div class="app-scroll">
    <header class="mobile-page-header"><button class="icon-button" aria-label="Menu proposal" data-go="menu">${icon("left")}</button><div><h2>Your cart</h2><p>2 items · design sample</p></div></header>
    <div class="cart-content"><div class="cart-outlet">${icon("pin")}<div><strong>Burgonomics Gota</strong>Takeaway · sample basket</div></div>
      ${cartLine("cheese-burst.jpg", "Cheese Burst Burger", "199")}${cartLine("hero.jpg", "Super Hero Burger", "219")}
      <details class="cooking-note" open><summary>Cooking instructions ${icon("down")}</summary><label for="proposal-order-note" class="sample-copy">One note for the whole order</label><textarea id="proposal-order-note" maxlength="240" aria-describedby="proposal-note-help">No onions, please.</textarea><div class="note-helper" id="proposal-note-help"><span>We'll pass this to the kitchen.</span><span id="proposal-note-count">18 / 240</span></div></details>
      <section class="bill" aria-labelledby="sample-bill-heading"><h3 id="sample-bill-heading">Illustrative bill</h3><div class="bill-row"><span>Item subtotal</span><strong>₹418.00</strong></div><div class="bill-row"><span>Tax — example only</span><strong>₹20.90</strong></div><div class="bill-row"><span>Other charges — example</span><strong>₹0.00</strong></div><div class="bill-total"><span>Sample total</span><strong>₹438.90</strong></div><p class="sample-copy">For layout review only. Final taxes and fees come from authoritative checkout pricing.</p></section>
    </div><div class="checkout-area"><button class="primary-button" data-demo>Continue to checkout ${icon("arrow")}</button><p>Prototype only. No order or payment will be created.</p></div>
  </div>${navigation("cart")}`;

const tickets = [
  { id:"S1043", column:"new", channel:"Delivery", age:"2:18", payment:"Paid", pos:"POS pending", tone:"warning", items:[[2,"Cheese Burst Burger"],[1,"Salted Fries"]], note:"No onions, please.", issue:"2-minute alert", detail:"Payment received. POS acknowledgement is still pending.", action:"Review POS status", footer:"Kitchen handoff not confirmed" },
  { id:"S1041", column:"new", channel:"Takeaway", age:"5:12", payment:"Paid", pos:"POS needs review", tone:"error", items:[[1,"Any Big Bang Burger Meal"]], note:"Pack sauces separately.", issue:"5-minute alert", detail:"Do not assume a ticket printed. Check the POS event history before retrying.", action:"Review POS issue", footer:"Manager attention needed" },
  { id:"S1039", column:"preparing", channel:"Delivery", age:"7:06", payment:"Paid", pos:"POS acknowledged", items:[[2,"Super Hero Burger"],[1,"Oreo Shake"]], action:"Mark ready", footer:"Accepted by kitchen" },
  { id:"S1040", column:"preparing", channel:"Takeaway", age:"4:32", payment:"Cash on pickup", pos:"POS acknowledged", items:[[1,"Great Indian Burger"],[1,"Salted Fries"]], note:"Extra napkins.", action:"Mark ready", footer:"Accepted by kitchen" },
  { id:"S1037", column:"ready", channel:"Delivery", age:"10:24", payment:"Paid", pos:"POS acknowledged", items:[[1,"Any Classic Burger Meal"]], issue:"Rider not assigned", detail:"The kitchen is done. Dispatch still needs attention.", tone:"warning", action:"Open dispatch", footer:"Ready for handoff" },
];
const status = (text, className, symbol = "") => `<span class="status-label ${className}">${symbol ? icon(symbol) : ""}${text}</span>`;
const ticket = (entry) => `<article class="ticket"><header class="ticket-head"><div><h4 class="ticket-number">#${entry.id}</h4><p class="ticket-channel">${entry.channel} · sample</p></div><span class="ticket-time">${icon("clock")}${entry.age}</span></header><div class="ticket-badges">${status(entry.payment,entry.payment === "Paid" ? "status-paid" : "status-pos",entry.payment === "Paid" ? "check" : "")}${status(entry.pos, entry.column === "new" ? `status-${entry.tone}` : "status-pos", entry.column === "new" ? "alert" : "check")}</div><ul class="ticket-items">${entry.items.map(([qty,name]) => `<li><span class="qty">${qty}×</span><span>${name}</span></li>`).join("")}</ul>${entry.note ? `<p class="ticket-note">Note: ${entry.note}</p>` : ""}${entry.issue ? `<div class="ticket-issue ${entry.tone === "error" ? "error" : ""}"><strong>${entry.issue}</strong>${entry.detail}</div>` : ""}<div class="ticket-action">${demoButton(entry.action,entry.column === "new" ? "secondary-button" : "primary-button")}</div><div class="ticket-footer"><span>${entry.footer}</span></div></article>`;
document.querySelector("#partner-proposal").innerHTML = `
  <aside class="partner-sidebar"><div class="partner-brand">${brand()}<p class="partner-subbrand">Partner</p></div><nav class="partner-nav" aria-label="Partner proposal navigation"><button class="active" data-partner="kitchen">${icon("kitchen")}Kitchen</button><button data-partner="orders">${icon("orders")}Orders</button><button data-demo>${icon("menu")}Menu</button><button data-demo>${icon("stock")}Stock</button><button data-demo>${icon("dispatch")}Dispatch</button><button data-demo>${icon("settings")}Settings</button></nav><div class="partner-sidebar-bottom"><strong>Invite-only workspace</strong>Roles and access stay server-controlled.</div></aside>
  <div class="partner-main"><header class="partner-topbar"><div class="partner-location">${icon("pin")}<div><strong>Burgonomics Gota</strong><p>Single-outlet operational view</p></div></div><div class="operator"><span>Sample operator</span><span class="operator-avatar">SO</span></div></header>
    <div class="partner-workspace"><div class="workspace-heading"><div><h2 id="partner-view-title">Kitchen</h2><p>Every order has a next action.</p></div><div class="workspace-actions"><span class="sample-badge">SYNTHETIC DATA</span><div class="partner-view-switch" role="group" aria-label="Partner work view"><button class="active" data-partner="kitchen">${icon("grid")}Kitchen</button><button data-partner="orders">${icon("list")}All orders</button></div></div></div>
    <div class="exception-banner">${icon("alert")}<div><strong>2 paid orders need POS attention</strong><p>Payment received does not mean a kitchen ticket was acknowledged.</p></div><button data-demo>Review issues</button></div>
    <div class="kds-board" id="partner-kitchen-view">${[["new","New orders"],["preparing","Preparing"],["ready","Ready"]].map(([key,title]) => `<section class="kds-column"><div class="column-title"><h3>${title}</h3><span>${tickets.filter(t=>t.column===key).length} sample${tickets.filter(t=>t.column===key).length===1?"":"s"}</span></div>${tickets.filter(t=>t.column===key).map(ticket).join("")}</section>`).join("")}</div>
    <div class="orders-table-wrap" id="partner-orders-view" hidden><table class="orders-table"><thead><tr><th>Order</th><th>Fulfilment</th><th>Payment</th><th>POS</th><th>Kitchen</th><th>Age</th><th>Next action</th></tr></thead><tbody>${tickets.map(t=>`<tr><td>#${t.id}</td><td>${t.channel}</td><td>${status(t.payment,t.payment==="Paid"?"status-paid":"status-pos")}</td><td>${status(t.pos,t.column==="new"?`status-${t.tone}`:"status-pos")}</td><td>${{new:"Not confirmed",preparing:"Preparing",ready:"Ready"}[t.column]}</td><td>${t.age}</td><td>${demoButton(t.column==="new"?"Review POS":"View order")}</td></tr>`).join("")}</tbody></table></div>
    <p class="workspace-footnote">Design sample: all ticket IDs, timings, counts, payment/POS states and dispatch states are illustrative. No live order or provider connection.</p>
    </div>
  </div>`;

const params = new URLSearchParams(location.search);
if (params.get("capture") === "1") document.body.classList.add("capture-mode");
let activeScreen = "home";
function showScreen(screen) {
  if (!["home","menu","partner"].includes(screen)) return;
  activeScreen = screen;
  document.querySelectorAll("[data-board]").forEach(board => { board.hidden = board.dataset.board !== screen; });
  document.querySelectorAll("[data-screen]").forEach(button => {
    if (button.dataset.screen === screen) button.setAttribute("aria-current","page");
    else button.removeAttribute("aria-current");
  });
  updateUrl();
}
function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("screen", activeScreen);
  url.searchParams.set("theme", document.body.dataset.theme);
  history.replaceState(null, "", url);
}
function setTheme(theme) {
  document.body.dataset.theme = theme === "dark" ? "dark" : "light";
  document.querySelectorAll("[data-theme-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === document.body.dataset.theme)));
  updateUrl();
}
let toastTimer;
function showPreviewMessage() {
  const toast = document.querySelector(".preview-toast");
  toast.textContent = "Design preview only. Nothing is sent, charged or saved.";
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}
document.addEventListener("click", event => {
  const target = event.target.closest("button,a");
  if (!target) return;
  if (target.dataset.screen) showScreen(target.dataset.screen);
  if (target.dataset.go) showScreen(target.dataset.go);
  if (target.dataset.themeChoice) setTheme(target.dataset.themeChoice);
  if (target.hasAttribute("data-demo")) { event.preventDefault(); showPreviewMessage(); }
  if (target.hasAttribute("data-mode")) target.parentElement.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button === target)));
  if (target.dataset.jump) {
    event.preventDefault();
    const section = document.getElementById(target.dataset.jump);
    const scroll = document.getElementById("menu-scroll");
    scroll.scrollTop = section.offsetTop - scroll.offsetTop - 86;
    document.querySelectorAll("[data-jump]").forEach(link => link.classList.toggle("active", link === target));
  }
  if (target.dataset.partner) {
    const orders = target.dataset.partner === "orders";
    document.getElementById("partner-kitchen-view").hidden = orders;
    document.getElementById("partner-orders-view").hidden = !orders;
    document.getElementById("partner-view-title").textContent = orders ? "Orders" : "Kitchen";
    document.querySelectorAll("[data-partner]").forEach(button => button.classList.toggle("active", button.dataset.partner === target.dataset.partner));
  }
});
document.getElementById("proposal-order-note").addEventListener("input", event => {
  document.getElementById("proposal-note-count").textContent = `${event.target.value.length} / 240`;
});
setTheme(params.get("theme"));
showScreen(params.get("screen") || "home");
