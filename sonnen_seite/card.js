// Sonnen-Laune-Karte: zeigt mit einer Sonne, ob der Strom von der PV oder vom Netz kommt.
// Optional: relay_entity (Lastrelais-Freigabe) + threshold_entity (Freigabe-Schwelle in % Akku).
class SonnenLauneCard extends HTMLElement {
  setConfig(config) {
    if (!config.source_entity && !config.grid_entity) throw new Error("source_entity oder grid_entity fehlt");
    this._config = Object.assign(
      { pv_max: 6000, pv_sunny: 300, title: "", show_info: ["pv", "soc", "load"], relay_on_state: "on", sun_entity: "sun.sun" },
      config
    );
    this._last = null;
  }

  static getStubConfig() {
    return { source_entity: "input_boolean.example", pv_entity: "sensor.pv_power" };
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, rows: "auto", min_rows: 5 }; }

  _num(hass, id) {
    if (!id || !hass.states[id]) return null;
    const v = parseFloat(hass.states[id].state);
    return isNaN(v) ? null : v;
  }

  set hass(hass) {
    const c = this._config;
    const src = hass.states[c.source_entity];
    let solar = src ? src.state === "on" : null;
    const pv = this._num(hass, c.pv_entity) ?? 0;
    const soc = this._num(hass, c.soc_entity);
    const load = this._num(hass, c.load_entity);
    const grid = this._num(hass, c.grid_entity);
    const thr = this._num(hass, c.threshold_entity);
    const relayObj = c.relay_entity ? hass.states[c.relay_entity] : null;
    const relayKnown = relayObj && !["unavailable", "unknown"].includes(relayObj.state);
    // released: true = Sonnenstrom freigegeben, false = gesperrt, null = keine Info
    const released = relayKnown ? relayObj.state === c.relay_on_state : null;
    // Nacht: von Sonnenuntergang bis Sonnenaufgang (sun.sun unter dem Horizont)
    const sunObj = c.sun_entity ? hass.states[c.sun_entity] : null;
    const night = !!sunObj && sunObj.state === "below_horizon";
    let wake = null;
    const nr = sunObj && sunObj.attributes ? sunObj.attributes.next_rising : null;
    if (night && nr) {
      const d = new Date(nr);
      if (!isNaN(d)) wake = d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
    }
    const key = [night, wake, solar, Math.round(pv / 50), soc, load === null ? null : Math.round(load / 10), grid === null ? null : Math.round(grid / 10), released, thr].join("|");
    if (key === this._last) return;
    this._last = key;

    // Laune von -1 (sehr traurig) bis +1 (sehr lustig)
    let mood, headline, sub;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const thrTxt = thr !== null ? `${Math.round(thr)}\u00a0%` : null;

    if (released === false) {
      // Lastrelais sperrt: Haus hängt am Netz, egal wie viel Sonne scheint
      solar = false;
      headline = "Strom kommt vom Netz";
      const prog = thr ? clamp((soc ?? 0) / thr) : 0;
      if (pv >= c.pv_sunny) {
        mood = -0.7 + 0.5 * prog;
        sub = thrTxt
          ? `Die Sonne lädt erst den Akku – ab ${thrTxt} gibt's Sonnenstrom. ⏳`
          : "Die Sonne lädt erst den Akku. ⏳";
      } else {
        mood = -1;
        sub = thrTxt
          ? `Keine Sonne – wir kaufen Strom. Sonnenstrom gibt's erst ab ${thrTxt} Akku.`
          : "Keine Sonne – wir kaufen Strom.";
      }
    } else if (c.grid_entity) {
      // Nur die Messwerte des Hauses: Anteil Netzbezug am Verbrauch
      if (load === null || grid === null) {
        mood = 0; solar = null; headline = "Keine Daten"; sub = "Die Zähler melden sich gerade nicht.";
      } else {
        const share = load > 20 ? clamp(1 - grid / load) : (grid > 20 ? 0 : 1);
        const pct = Math.round(share * 100);
        mood = -1 + 2 * share;
        if (share >= 0.9) {
          solar = true; headline = "Strom kommt von der Sonne"; sub = "Alles Sonnenstrom – gratis! 😊";
        } else if (share <= 0.1) {
          solar = false; headline = "Strom kommt vom Netz"; sub = "Wir kaufen gerade Strom.";
        } else {
          solar = share >= 0.5; headline = "Sonne und Netz gemischt"; sub = `${pct} % kommen gerade von der Sonne.`;
        }
      }
    } else if (solar === null) {
      mood = 0; headline = "Keine Daten"; sub = "Die Anlage meldet sich gerade nicht.";
    } else if (solar) {
      mood = 0.35 + 0.65 * clamp(pv / c.pv_max);
      headline = "Strom kommt von der Sonne";
      sub = pv >= c.pv_sunny
        ? "Die Sonne scheint – alles gratis! 😊"
        : "Gerade aus dem Akku – auch Sonnenstrom 🔋";
    } else {
      if (pv >= c.pv_sunny) {
        mood = -0.25 + 0.2 * clamp(pv / c.pv_max);
        headline = "Strom kommt vom Netz";
        sub = "Die Sonne lädt gerade erst den Akku auf.";
      } else {
        mood = -1;
        headline = "Strom kommt vom Netz";
        sub = "Keine Sonne – wir kaufen Strom.";
      }
    }
    if (night && sub) sub = sub.replace("Keine Sonne – ", "Nachts – ");
    this._render(mood, headline, sub, pv, soc, load, solar, { released, thr }, { night, wake });
  }

  // Schlafende Sonne mit Zipfelmütze, schwebenden „Zzz“ – für die Nacht
  _sleepingSun(solar) {
    let rays = "";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r1 = 76, r2 = 88;
      rays += `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 + r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 + r2 * Math.sin(a)}" stroke="#e9b949" stroke-width="8" stroke-linecap="round"/>`;
    }
    const mouth = solar
      ? `<path d="M 90 124 Q 100 132 110 124" stroke="#7a3a12" stroke-width="5" fill="none" stroke-linecap="round"/>`
      : `<ellipse class="snore" cx="100" cy="126" rx="6" ry="5" fill="#8a3b12"/>`;
    return `
      <g class="breathe">
        <g class="nrays">${rays}</g>
        <circle cx="100" cy="100" r="70" fill="#f7d774" stroke="#e9b949" stroke-width="4"/>
        <path d="M 62 90 Q 76 102 90 90" stroke="#5a2a0a" stroke-width="5.5" fill="none" stroke-linecap="round"/>
        <path d="M 110 90 Q 124 102 138 90" stroke="#5a2a0a" stroke-width="5.5" fill="none" stroke-linecap="round"/>
        <ellipse cx="58" cy="112" rx="11" ry="7" fill="#ff8a65" opacity=".45"/>
        <ellipse cx="142" cy="112" rx="11" ry="7" fill="#ff8a65" opacity=".45"/>
        ${mouth}
        <g class="cap">
          <path d="M 34 72 Q 62 4 140 18 Q 196 30 196 96 Q 182 60 166 72 Z" fill="#5c6bc0"/>
          <path d="M 70 30 Q 76 44 70 58 M 104 20 Q 110 36 106 50 M 140 22 Q 146 38 142 54 M 172 40 Q 176 54 174 66" stroke="#7986cb" stroke-width="6" fill="none" stroke-linecap="round"/>
          <path d="M 34 72 A 70 70 0 0 1 166 72" stroke="#f3f3fb" stroke-width="13" fill="none" stroke-linecap="round"/>
          <circle class="pom" cx="196" cy="100" r="10" fill="#f3f3fb"/>
        </g>
      </g>
      <g font-family="Georgia, serif" font-weight="700" fill="#e6ecff">
        <text class="z z1" x="16" y="70" font-size="20">z</text>
        <text class="z z2" x="16" y="70" font-size="27">z</text>
        <text class="z z3" x="16" y="70" font-size="34">Z</text>
      </g>`;
  }

  _render(mood, headline, sub, pv, soc, load, solar, rel, nightInfo) {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const night = !!(nightInfo && nightInfo.night);
    const m = mood;
    const happy = m > 0;
    // Farben: von grau-gelb (traurig) zu kräftigem Gold (lustig)
    const t = (m + 1) / 2;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    const face = `rgb(${mix(200, 255)},${mix(190, 196)},${mix(140, 20)})`;
    const ray = `rgb(${mix(185, 255)},${mix(175, 160)},${mix(130, 0)})`;
    const bg = night
      ? "linear-gradient(180deg,#0f1b3d 0%,#2a3a6e 70%,#3d4c80 100%)"
      : solar
      ? "linear-gradient(180deg,#bfe6ff 0%,#fff6d6 100%)"
      : solar === false
        ? "linear-gradient(180deg,#c9d2dc 0%,#eef1f4 100%)"
        : "var(--card-background-color)";

    // Mund: Kurve nach oben (lachen) oder unten (traurig)
    const my = 128 - 6 * m;
    const curve = 34 * m;
    const mw = 26 + 6 * Math.max(0, m);
    let mouth;
    if (m > 0.6) {
      // offener, lachender Mund
      mouth = `<path d="M ${100 - mw} ${my} Q 100 ${my + curve + 6} ${100 + mw} ${my} Z" fill="#8a3b12"/>
               <path d="M ${100 - mw * 0.55} ${my + curve * 0.55} Q 100 ${my + curve * 0.75 + 4} ${100 + mw * 0.55} ${my + curve * 0.55}" fill="#e2585a"/>`;
    } else {
      mouth = `<path d="M ${100 - mw} ${my} Q 100 ${my + curve} ${100 + mw} ${my}" stroke="#7a3a12" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    }

    // Augen
    let eyes;
    if (m > 0.6) {
      eyes = `<path d="M 66 88 Q 76 76 86 88" stroke="#5a2a0a" stroke-width="6" fill="none" stroke-linecap="round"/>
              <path d="M 114 88 Q 124 76 134 88" stroke="#5a2a0a" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    } else {
      eyes = `<circle cx="76" cy="88" r="8" fill="#5a2a0a"/><circle cx="124" cy="88" r="8" fill="#5a2a0a"/>
              <circle cx="78.5" cy="85.5" r="2.5" fill="#fff"/><circle cx="126.5" cy="85.5" r="2.5" fill="#fff"/>`;
    }
    // Augenbrauen nur bei traurig
    const brows = m < -0.1
      ? `<path d="M 62 ${72 - 5 * m} L 88 ${72 + 6 * m}" stroke="#5a2a0a" stroke-width="5" stroke-linecap="round"/>
         <path d="M 138 ${72 - 5 * m} L 112 ${72 + 6 * m}" stroke="#5a2a0a" stroke-width="5" stroke-linecap="round"/>`
      : "";
    const cheeks = m > 0.3
      ? `<ellipse cx="60" cy="112" rx="11" ry="7" fill="#ff8a65" opacity="${0.25 + 0.4 * m}"/>
         <ellipse cx="140" cy="112" rx="11" ry="7" fill="#ff8a65" opacity="${0.25 + 0.4 * m}"/>`
      : "";
    const tear = m < -0.6
      ? `<path class="tear" d="M 124 98 Q 118 110 124 116 Q 130 110 124 98 Z" fill="#4fa3e0"/>`
      : "";
    const cloud = m < -0.6
      ? `<g class="cloud" opacity="0.92"><ellipse cx="160" cy="44" rx="30" ry="16" fill="#fff"/><ellipse cx="140" cy="50" rx="20" ry="13" fill="#fff"/><ellipse cx="180" cy="52" rx="18" ry="11" fill="#fff"/></g>`
      : "";

    let rays = "";
    const n = 12;
    const len = 18 + 14 * Math.max(0, m);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r1 = 76, r2 = 76 + len;
      rays += `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 + r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 + r2 * Math.sin(a)}" stroke="${ray}" stroke-width="9" stroke-linecap="round"/>`;
    }
    const spin = happy ? Math.round(40 - 25 * m) : 0;
    const bounce = m > 0.6 ? "bounce" : "";

    const nightHtml = night
      ? `<div class="moon"></div>
         <span class="star" style="top:14%;left:12%;animation-delay:0s"></span>
         <span class="star" style="top:8%;left:78%;animation-delay:.7s"></span>
         <span class="star" style="top:26%;left:88%;animation-delay:1.4s"></span>
         <span class="star" style="top:34%;left:6%;animation-delay:2.1s"></span>
         <span class="star small" style="top:6%;left:46%;animation-delay:1s"></span>
         <span class="star small" style="top:20%;left:30%;animation-delay:2.6s"></span>
         <span class="star small" style="top:44%;left:92%;animation-delay:.4s"></span>`
      : "";
    const wakeHtml = night
      ? `<div class="wake">😴 Die Sonne schläft${nightInfo.wake ? ` – sie wacht um ${nightInfo.wake} Uhr auf` : ""}.</div>`
      : "";
    const svgInner = night
      ? this._sleepingSun(solar)
      : `<g class="rays">${rays}</g>
          <g class="face ${bounce}">
            <circle cx="100" cy="100" r="70" fill="${face}" stroke="${ray}" stroke-width="4"/>
            ${cheeks}${brows}${eyes}${mouth}${tear}
          </g>
          ${cloud}`;
    const h2col = night
      ? (solar ? "#ffe08a" : solar === false ? "#ffb4a8" : "inherit")
      : (solar ? "#b86e00" : solar === false ? "#a33" : "inherit");

    const fmt = (v, u) => (v === null || v === undefined ? "–" : `${Math.round(v).toLocaleString("de-AT")} ${u}`);

    // Freigabe-Anzeige (Lastrelais)
    let relHtml = "";
    if (rel && rel.released === true) {
      relHtml = `<div class="pill ok">✅ Sonnenstrom freigegeben</div>`;
    } else if (rel && rel.released === false) {
      const s = soc ?? 0;
      const pct = rel.thr ? Math.max(0, Math.min(100, (s / rel.thr) * 100)) : 0;
      relHtml = `<div class="pill lock">🔒 Sonnenstrom noch gesperrt</div>
        ${rel.thr ? `<div class="prog"><div class="bar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="ptxt">Akku ${Math.round(s)} % – Freigabe ab ${Math.round(rel.thr)} %</div></div>` : ""}`;
    }

    const infos = [];
    const show = this._config.show_info || [];
    if (this._config.pv_entity && show.includes("pv")) infos.push(`<div class="info"><span>☀️ Sonne liefert</span><b>${fmt(pv, "W")}</b></div>`);
    if (this._config.soc_entity && show.includes("soc")) infos.push(`<div class="info"><span>🔋 Akku</span><b>${fmt(soc, "%")}</b></div>`);
    if (this._config.load_entity && show.includes("load")) infos.push(`<div class="info"><span>🏠 ${this._config.load_name || "Verbrauch"}</span><b>${fmt(load, "W")}</b></div>`);

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { position: relative; background: ${bg}; overflow: hidden; text-align: center; padding: 16px 12px 18px; color: ${night ? "#e6ecff" : "#2b2b2b"}; }
        ha-card > *:not(.star):not(.moon) { position: relative; }
        .moon { position: absolute; top: 14px; left: 18px; width: 34px; height: 34px; border-radius: 50%; box-shadow: 9px 6px 0 0 #fdf1b8; transform: rotate(-20deg); }
        .star { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #fff; box-shadow: 0 0 6px 2px rgba(255,255,255,.7); animation: twinkle 3s ease-in-out infinite; }
        .star.small { width: 3px; height: 3px; }
        @keyframes twinkle { 0%,100% { opacity: .25; transform: scale(.7) } 50% { opacity: 1; transform: scale(1.15) } }
        .breathe { transform-origin: 100px 110px; animation: breathe 4.5s ease-in-out infinite; }
        @keyframes breathe { 0%,100% { transform: scale(1) } 50% { transform: scale(1.035) } }
        .snore { transform-origin: 100px 126px; animation: snore 4.5s ease-in-out infinite; }
        @keyframes snore { 0%,100% { transform: scale(.6) } 50% { transform: scale(1.15) } }
        .pom { transform-origin: 196px 72px; animation: sway 4.5s ease-in-out infinite; }
        @keyframes sway { 0%,100% { transform: rotate(-4deg) } 50% { transform: rotate(5deg) } }
        .z { opacity: 0; animation: zz 4.5s ease-out infinite; }
        .z2 { animation-delay: 1.5s; } .z3 { animation-delay: 3s; }
        @keyframes zz { 0% { opacity: 0; transform: translate(0,0) } 15% { opacity: 1 } 100% { opacity: 0; transform: translate(-22px,-58px) } }
        .wake { margin-top: 10px; font-size: 1.05em; opacity: .9; }
        @media (prefers-reduced-motion: reduce) { .breathe, .snore, .pom, .z, .star, .rays, .face, .tear, .cloud { animation: none !important; } .z { opacity: .8; } }
        .title { font-size: 1.1em; opacity: .7; margin-bottom: 4px; }
        svg { width: 100%; max-width: 260px; height: auto; display: block; margin: 0 auto; }
        .rays { transform-origin: 100px 100px; ${spin ? `animation: spin ${spin}s linear infinite;` : ""} }
        .face.bounce { transform-origin: 100px 100px; animation: bounce 1.6s ease-in-out infinite; }
        .tear { animation: drop 2.4s ease-in infinite; }
        .cloud { animation: drift 6s ease-in-out infinite alternate; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes bounce { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        @keyframes drop { 0% { transform: translateY(0); opacity: 1 } 80% { transform: translateY(26px); opacity: 0 } 100% { opacity: 0 } }
        @keyframes drift { from { transform: translateX(-8px) } to { transform: translateX(8px) } }
        h2 { margin: 10px 0 2px; font-size: 1.7em; line-height: 1.2; color: ${h2col}; }
        .sub { font-size: 1.15em; opacity: .85; }
        .pill { display: inline-block; margin-top: 12px; padding: 6px 14px; border-radius: 999px; font-size: 1.1em; font-weight: 600; }
        .pill.ok { background: #d8f3d0; color: #2e6b1f; }
        .pill.lock { background: #fde2d6; color: #9a3a16; }
        .prog { max-width: 320px; margin: 10px auto 0; }
        .bar { height: 14px; border-radius: 7px; background: rgba(0,0,0,.12); overflow: hidden; }
        .fill { height: 100%; border-radius: 7px; background: linear-gradient(90deg,#f5b400,#7cc243); transition: width .6s; }
        .ptxt { font-size: 1em; opacity: .8; margin-top: 4px; }
        .infos { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
        .info { background: ${night ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.65)"}; border-radius: 12px; padding: 6px 10px; min-width: 76px; }
        .info span { display: block; font-size: .9em; opacity: .75; }
        .info b { font-size: 1.2em; white-space: nowrap; }
      </style>
      <ha-card>
        ${nightHtml}
        ${this._config.title ? `<div class="title">${this._config.title}</div>` : ""}
        <svg viewBox="-10 -10 220 220" role="img" aria-label="${headline}">
          ${svgInner}
        </svg>
        <h2>${headline}</h2>
        <div class="sub">${sub}</div>
        ${wakeHtml}
        ${relHtml}
        ${infos.length ? `<div class="infos">${infos.join("")}</div>` : ""}
      </ha-card>`;
  }
}

if (!customElements.get("sonnen-laune-card")) {
  customElements.define("sonnen-laune-card", SonnenLauneCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sonnen-laune-card",
    name: "Sonnen-Laune",
    description: "Lachende oder traurige Sonne – Strom von der PV oder vom Netz",
  });
}
