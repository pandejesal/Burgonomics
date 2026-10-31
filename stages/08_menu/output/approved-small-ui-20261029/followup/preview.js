const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const screen of ["home", "menu", "cart"]) {
  document.getElementById(`${screen}-frame`).src = `../${screen}-${theme}.html`;
}
