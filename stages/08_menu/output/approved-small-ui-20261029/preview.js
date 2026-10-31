const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
for (const screen of ["home", "cart"]) {
  document.getElementById(`${screen}-frame`).src = `./${screen}-${theme}.html`;
}
