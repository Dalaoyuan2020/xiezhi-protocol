// 廌点金币动画（不发廌点，只负责「看得见」）：
//   Zhidian.drop(amount, target)：认领 / 验收通过后，一枚獬豸金币从天而降，落到余额处
//   Zhidian.rain(n, caption)：彩蛋：查到高分学者时，天上下一阵金币雨（纯动画，不额外发廌点）
(function () {
  const COIN = "/brand/zhidian-coin-256.png";
  let coinReady, coinLoaded = false, rainVersion = 0, currentRain;
  function loadCoin() {
    if (coinLoaded) return Promise.resolve(true);
    if (!coinReady) coinReady = new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => resolve(false), 1800);
      img.onload = () => { coinLoaded = img.naturalWidth > 0; clearTimeout(timer); resolve(coinLoaded); };
      img.onerror = () => { clearTimeout(timer); resolve(false); };
      img.src = COIN;
    });
    return coinReady;
  }
  const layer = () => {
    let el = document.getElementById("zhidian-layer");
    if (!el) {
      el = document.createElement("div"); el.id = "zhidian-layer";
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "9999", overflow: "hidden" });
      document.body.appendChild(el);
    }
    return el;
  };
  const coin = (size, loaded = true) => {
    const token = document.createElement("span"); token.className = "zhidian-coin";
    Object.assign(token.style, { position: "absolute", display: "grid", placeItems: "center", boxSizing: "border-box", width: size + "px", height: size + "px", left: "0", top: "0", willChange: "transform, opacity", filter: "drop-shadow(0 5px 7px rgba(80,50,10,.25))" });
    const fallback = () => {
      token.replaceChildren(); token.textContent = "廌";
      Object.assign(token.style, { borderRadius: "50%", border: "3px solid #e3ba59", background: "radial-gradient(circle at 35% 25%,#fff1ad,#dca331)", color: "#8c4825", font: `700 ${Math.round(size * .5)}px serif`, boxShadow: "inset 0 0 0 2px #fff1ac" });
    };
    if (loaded) {
      const img = new Image(); img.src = COIN; img.alt = ""; img.decoding = "async";
      Object.assign(img.style, { display: "block", width: "100%", height: "100%", objectFit: "contain" });
      img.onerror = fallback; token.appendChild(img);
    } else fallback();
    return token;
  };
  function animate(node, frames, options) {
    if (typeof node.animate !== "function") {
      Object.assign(node.style, frames[Math.floor(frames.length / 2)]);
      setTimeout(() => node.remove(), options.duration);
      return;
    }
    const animation = node.animate(frames, options);
    animation.onfinish = () => node.remove();
    animation.oncancel = () => node.remove();
  }
  function label(text, x, y) {
    const t = document.createElement("div"); t.textContent = text;
    Object.assign(t.style, { position: "absolute", left: x + "px", top: y + "px", transform: "translate(-50%,-50%)", font: "700 26px 'PingFang SC',sans-serif", color: "#b8292f", textShadow: "0 2px 0 #fff, 0 0 12px rgba(255,220,140,.9)", whiteSpace: "nowrap" });
    layer().appendChild(t);
    animate(t, [{ opacity: 0, transform: "translate(-50%,-30%) scale(.6)" }, { opacity: 1, transform: "translate(-50%,-80%) scale(1.1)", offset: 0.3 }, { opacity: 1, transform: "translate(-50%,-110%) scale(1)", offset: 0.8 }, { opacity: 0, transform: "translate(-50%,-150%) scale(1)" }], { duration: 1800, easing: "ease-out" });
  }
  function drop(amount, target) {
    const W = window.innerWidth, H = window.innerHeight, size = Math.min(140, W * 0.3);
    const r = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const tx = r && r.width ? r.left + 30 : W / 2, ty = r && r.height && r.top > 0 && r.top < H ? r.top + r.height / 2 : H * 0.45;
    const text = amount ? `+${amount} 廌点` : "廌点 +";
    const c = coin(size); layer().appendChild(c);
    const x0 = W / 2 - size / 2, land = H * 0.42;
    c.animate([
      { transform: `translate(${x0}px, ${-size * 1.5}px) rotateY(0deg) scale(1)` },
      { transform: `translate(${x0}px, ${land}px) rotateY(720deg) scale(1)`, offset: 0.45, easing: "cubic-bezier(.3,1.6,.5,1)" },
      { transform: `translate(${x0}px, ${land - 40}px) rotateY(900deg) scale(1.05)`, offset: 0.6 },
      { transform: `translate(${x0}px, ${land}px) rotateY(1080deg) scale(1)`, offset: 0.72 },
      { transform: `translate(${tx - size * 0.15}px, ${ty - size * 0.15}px) rotateY(1080deg) scale(.3)`, opacity: 0.2 },
    ], { duration: 2000, easing: "ease-in-out", fill: "forwards" }).onfinish = () => c.remove();
    setTimeout(() => label(text, W / 2, land - 18), 900);
  }
  function clearRain() {
    rainVersion++;
    if (!currentRain) return;
    clearTimeout(currentRain.timer);
    currentRain.group.getAnimations?.({ subtree: true }).forEach(animation => animation.cancel());
    currentRain.group.remove(); currentRain = null;
  }
  async function rain(n, caption) {
    clearRain();
    const version = rainVersion, loaded = await loadCoin();
    if (version !== rainVersion) return;
    const W = window.innerWidth, H = window.innerHeight;
    const requested = Number.isFinite(n) ? Math.max(1, Math.min(70, Math.round(n))) : 36;
    // Bound the particle count on phones while keeping the complete shower.
    const count = Math.min(requested, W < 600 ? 28 : 70);
    const L = document.createElement("div"); L.className = "zhidian-rain";
    Object.assign(L.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    layer().appendChild(L);
    const effect = currentRain = { group: L, timer: null };
    if (caption) {
      const b = document.createElement("div"); b.className = "zhidian-rain-caption"; b.textContent = caption;
      Object.assign(b.style, { position: "absolute", zIndex: "1", left: "50%", top: "14%", transform: "translateX(-50%)", width: "max-content", maxWidth: "calc(100% - 32px)", boxSizing: "border-box", padding: "10px 18px", borderRadius: "20px", background: "rgba(184,41,47,.94)", color: "#fff7e6", font: `600 ${W < 600 ? 14 : 18}px/1.6 'PingFang SC',sans-serif`, textAlign: "center", boxShadow: "0 6px 20px rgba(120,20,20,.2)", whiteSpace: "normal" });
      L.appendChild(b);
      animate(b, [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 3800 });
    }
    for (let i = 0; i < count; i++) {
      const size = 40 + Math.random() * (W < 600 ? 26 : 42);
      const c = coin(size, loaded), x = ((i + .25 + Math.random() * .5) / count) * (W - size);
      const sway = (Math.random() - .5) * Math.min(90, W * .12);
      const endX = Math.max(0, Math.min(W - size, x + sway));
      const duration = 2400 + Math.random() * 700;
      L.appendChild(c);
      // Use bounded 2D turns: coins stay visible instead of becoming edge-on.
      const turn = (Math.random() > .5 ? 1 : -1) * 100;
      animate(c, [
        { transform: `translate(${x}px, ${-size}px) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${x}px, ${H * .08}px) rotate(${turn * .12}deg)`, opacity: 1, offset: .14 },
        { transform: `translate(${endX}px, ${H * .78}px) rotate(${turn * .8}deg)`, opacity: 1, offset: .82 },
        { transform: `translate(${endX}px, ${H + size}px) rotate(${turn}deg)`, opacity: 0 },
      ], { duration, delay: (i / count) * 700, easing: "linear", fill: "both" });
    }
    effect.timer = setTimeout(() => { L.remove(); if (currentRain === effect) currentRain = null; }, 4400);
  }
  window.addEventListener("pagehide", clearRain);
  window.Zhidian = { drop, rain, clearRain };
})();
