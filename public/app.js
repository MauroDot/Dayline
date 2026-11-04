"use strict";
const el = id => document.getElementById(id);
el("year").textContent = String(new Date().getFullYear());
el("clock").textContent = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }).format(new Date());
function node(tag, text, className) {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}
function setState(id, message, className = "info") {
  const target = el(id);
  target.replaceChildren(node("p", message, className));
}
async function loadJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Official feed unavailable");
  return response.json();
}
function dollars(s) {
  const n = Number(s);
  return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : "Unavailable";
}
async function loadDebt() {
  setState("debt", "Checking the latest official Treasury record…", "loading");
  try {
    const { data, stale, cachedAt } = await loadJSON("/api/debt");
    const target = el("debt");
    target.replaceChildren(node("p", dollars(data.total), "value"), node("p", "Reported as of " + data.asOf, "info"), node("p", "Debt held by public: " + dollars(data.heldByPublic), "info"), node("p", "Intragovernmental: " + dollars(data.intragovernmental), "info"), node("p", (stale ? "Cached, update delayed · " : "Retrieved · ") + new Date(cachedAt).toLocaleString(), "info"));
  } catch { setState("debt", "Official Treasury data is unavailable. No figure is displayed until a valid record is retrieved.", "error"); }
}
async function loadWeather() {
  const city = el("city").value;
  setState("weather", "Checking the official " + city + " forecast…", "loading");
  try {
    const { data, stale, cachedAt } = await loadJSON("/api/weather?city=" + encodeURIComponent(city));
    if (el("city").value !== city) return;
    const target = el("weather");
    const f = Math.round(data.temperatureF);
    target.replaceChildren(node("p", f + "°F · " + data.period, "value"), node("p", data.description, "info"), node("p", data.wind ? "Wind: " + data.wind : "Wind detail unavailable", "info"), node("p", (stale ? "Cached, update delayed · " : "Retrieved · ") + new Date(cachedAt).toLocaleString(), "info"));
  } catch { if (el("city").value === city) setState("weather", "The National Weather Service forecast is unavailable right now.", "error"); }
}
el("city").addEventListener("change", loadWeather);
loadDebt();
loadWeather();
