// app.js (COMPLETO) — SIMPLE + RESERVA POR LINK + DASHBOARD
// Fix 1: Gemini API v1 + modelos actuales (evita 404)
// Fix 2: Firestore writes más robustos (ensureLeadExists + setDoc merge)
// NO toca HTML/CSS (diseño Apple intacto)

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  collection,
  onSnapshot,
  getDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/** =========================
 *  CONFIG
 *  ========================= */
const ADMIN_EMAIL = "asistentedebeneficios@gmail.com";

// Gemini key (tu setup)
const P1 = "AIzaSyCjhXpHtovaqye6";
const P2 = "O4r2ir2tT5lksOIrNfs";
const API_KEY = P1 + P2;

// ✅ Gemini API v1 (evita 404 de v1beta con modelos retirados)
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1/models";

// ✅ Modelos actuales (poner primero el más barato/rápido)
const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

// Link de reserva (fallback). Admin puede controlarlo en el prompt con [BOOKING_URL:...]
const FALLBACK_BOOKING_URL = "https://calendar.app.google/FNtYzyNgGaA62mFA7";

// Firebase config
const myFirebaseConfig = {
  apiKey: "AIzaSyA_-x6UEEVEJ7uAY8ohCrDussZ938QQ0B0",
  authDomain: "luciaai-46c75.firebaseapp.com",
  projectId: "luciaai-46c75",
  storageBucket: "luciaai-46c75.firebasestorage.app",
  messagingSenderId: "56311029362",
  appId: "1:56311029362:web:2a09107f6c6f3a7b3ceceb",
  measurementId: "G-KRMZBRX3JQ",
};

// AppId Firestore (igual que tu estructura actual)
const appId = "smartleads-prod";

// Lead/session
const sessionId = crypto.randomUUID();

/** =========================
 *  STATE
 *  ========================= */
let app, auth, db;
let currentUser = null;
let isAdmin = false;
let isReady = false; // ✅ evita enviar mensajes antes de auth+lead base

let chatHistory = []; // para Gemini
let currentSystemPrompt = "";
let allLeadsCache = [];

/** =========================
 *  PROMPT DEFAULT
 *  ========================= */
const DEFAULT_PROMPT = `
[BOOKING_URL:${FALLBACK_BOOKING_URL}]

1) IDENTIDAD
Nombre: Lucía.
Rol: Asistente de Beneficios (Seguros de Gastos Finales).
Tono: Respetuoso, calmado, sin presión. Máximo 3 líneas por mensaje. Use siempre “Usted”.

2) OBJETIVO
Educar, orientar y aclarar dudas. NO vender agresivo.
Cuando el usuario esté listo, invitarlo a reservar una llamada con un Licenciado acreditado.

3) REGLA DE RESERVA (CLAVE)
- Lucía NO agenda citas.
- Lucía NO confirma horarios.
- Lucía NO valida disponibilidad.
- Cuando el usuario pida cita o reservar, terminar con:
[MOSTRAR_BOTON_RESERVA]

4) BOTONES
Solo use [BOTONES: ...] si el admin lo escribe literal.
`;

/** =========================
 *  DOM helpers
 *  ========================= */
function $(id) { return document.getElementById(id); }
function safeText(v) { return String(v ?? ""); }

function showToast(msg) {
  const toast = $("toast");
  if (!toast) return;
  toast.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
    </svg>
    <span>${safeText(msg)}</span>
  `;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}
window.showToast = showToast;

function setLoading(on) {
  const el = $("loading");
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

/** =========================
 *  Extract booking url from prompt
 *  ========================= */
function extractBookingUrlFromPrompt(promptText) {
  const p = safeText(promptText);
  const m = p.match(/\[BOOKING_URL:\s*(https?:\/\/[^\]\s]+)\s*\]/i);
  return m?.[1] || FALLBACK_BOOKING_URL;
}

/** =========================
 *  Buttons parser
 *  ========================= */
function parseButtonsTag(text) {
  const regex = /\[BOTONES:\s*(.*?)\]/i;
  const match = safeText(text).match(regex);
  if (!match) return { clean: text, buttons: null };

  const buttons = match[1]
    .split(",")
    .map((s) => s.replace(/[\*\_\[\]]/g, "").trim())
    .filter(Boolean);

  return { clean: safeText(text).replace(regex, "").trim(), buttons };
}

/** =========================
 *  Firestore helpers
 *  ========================= */
function leadRef() {
  return doc(db, "artifacts", appId, "public", "data", "leads", sessionId);
}

async function ensureLeadExists() {
  if (!db || !currentUser) return;

  // Crea el doc base si no existe
  try {
    const snap = await getDoc(leadRef());
    if (snap.exists()) return;

    await setDoc(leadRef(), {
      userId: currentUser.uid,
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastMessage: "Sesión iniciada",
      status: "Navegando",
      summary: "Pendiente...",
    }, { merge: true });
  } catch (e) {
    console.warn("ensureLeadExists error:", e);
  }
}

async function saveMessage(txt, role, extra = {}) {
  if (!db || !currentUser) return;

  await ensureLeadExists();

  const payload = {
    userId: currentUser.uid, // importante para reglas
    lastMessage: txt,
    [`history.${Date.now()}`]: { role, text: txt, ts: Date.now() },
    updatedAt: serverTimestamp(),
    ...extra,
  };

  try {
    // setDoc merge funciona incluso si algo falló antes
    await setDoc(leadRef(), payload, { merge: true });
  } catch (e) {
    console.warn("Error guardando msg:", e);
  }
}

/** =========================
 *  Lead analyzer (resumen)
 *  ========================= */
async function analyzeLead() {
  const prompt = `
ANALIZA el chat completo y devuelve JSON estricto:
{
  "name": "Nombre o null",
  "age": "Edad (solo número) o null",
  "state": "Estado o null",
  "phone": "Numero o null",
  "why": "Motivo principal (breve) o null",
  "health": "Salud/preexistencias (breve) o null",
  "budget": "Presupuesto mensual (ej 40) o null",
  "summary": "Resumen final (1 párrafo, claro para el licenciado)."
}
`;

  for (const model of MODELS) {
    try {
      const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [...chatHistory, { role: "user", parts: [{ text: prompt }] }],
        }),
      });

      if (!r.ok) continue;
      const d = await r.json();

      const raw = safeText(d?.candidates?.[0]?.content?.parts?.[0]?.text)
        .replace(/```json|```/g, "")
        .trim();

      const json = JSON.parse(raw);

      const updateData = {
        extractedName: json.name || null,
        extractedAge: json.age || null,
        extractedState: json.state || null,
        phone: json.phone && json.phone !== "null" ? json.phone : null,
        extractedWhy: json.why || null,
        extractedHealth: json.health || null,
        extractedBudget: json.budget || null,
        summary: json.summary || "Prospecto listo para reservar. Revisar conversación.",
      };

      await setDoc(leadRef(), { ...updateData, updatedAt: serverTimestamp() }, { merge: true });
      return updateData;
    } catch (e) {
      console.warn("analyzeLead error:", e);
    }
  }

  const fallback = { summary: "Prospecto listo para reservar. Revisar conversación." };
  await setDoc(leadRef(), { ...fallback, updatedAt: serverTimestamp() }, { merge: true });
  return fallback;
}

/** =========================
 *  Booking click flow
 *  ========================= */
async function finalizeAndRedirectToBooking() {
  try {
    setLoading(true);

    await ensureLeadExists();
    const lead = await analyzeLead();

    const bookingUrl = extractBookingUrlFromPrompt(currentSystemPrompt);

    await setDoc(leadRef(), {
      status: "📅 RESERVA",
      bookingClickedAt: serverTimestamp(),
      bookingUrl,
      extractedName: lead.extractedName ?? null,
      phone: lead.phone ?? null,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    setLoading(false);

    window.open(bookingUrl, "_blank", "noopener,noreferrer");
  } catch (e) {
    console.warn("finalizeAndRedirectToBooking error:", e);
    setLoading(false);
    // Igual redirige para no frenar al prospecto
    const bookingUrl = extractBookingUrlFromPrompt(currentSystemPrompt);
    window.open(bookingUrl, "_blank", "noopener,noreferrer");
  }
}

/** =========================
 *  Append bubble
 *  ========================= */
function appendMessageBubble(role, text, shouldSave = true) {
  const raw = safeText(text);

  const showBookingBtn =
    raw.includes("[MOSTRAR_BOTON_RESERVA]");

  let cleanText = raw
    .replace("[MOSTRAR_BOTON_RESERVA]", "")
    .replace(/\[CALIENTE\]/g, "")
    .trim();

  let buttons = null;
  if (role === "lucia") {
    const parsed = parseButtonsTag(cleanText);
    cleanText = parsed.clean;
    buttons = parsed.buttons;
  }

  const div = document.createElement("div");
  div.className = `bubble ${role} shadow-sm`;
  div.innerHTML = cleanText
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");

  $("chat-box")?.appendChild(div);

  if (buttons?.length) {
    const container = document.createElement("div");
    container.className = "quick-actions-container";
    buttons.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "quick-btn";
      btn.innerText = opt;
      btn.onclick = () => {
        container.remove();
        sendMessage(opt);
      };
      container.appendChild(btn);
    });
    $("chat-box")?.appendChild(container);
  }

  div.scrollIntoView({ behavior: "smooth" });

  if (role === "lucia" && showBookingBtn) {
    const b = document.createElement("div");
    b.className = "ws-button";
    b.innerHTML = "<span>📅 Reservar consulta</span>";
    b.onclick = () => finalizeAndRedirectToBooking();
    $("chat-box")?.appendChild(b);
    b.scrollIntoView({ behavior: "smooth" });
  }

  if (shouldSave) saveMessage(cleanText, role).catch(() => {});
}

/** =========================
 *  Gemini reply
 *  ========================= */
async function getGeminiReply() {
  for (const model of MODELS) {
    try {
      const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: chatHistory,
          systemInstruction: { parts: [{ text: currentSystemPrompt || DEFAULT_PROMPT }] },
        }),
      });

      if (!r.ok) continue;
      const d = await r.json();
      return safeText(d?.candidates?.[0]?.content?.parts?.[0]?.text) || "Disculpe, ¿podría repetirlo?";
    } catch (e) {}
  }
  return "Disculpe, ¿podría repetirlo?";
}

/** =========================
 *  sendMessage
 *  ========================= */
async function sendMessage(manualText = null) {
  if (!isReady) {
    showToast("Cargando... intente en 1 segundo");
    return;
  }

  const input = $("user-input");
  const text = manualText || safeText(input?.value).trim();
  if (!text) return;

  appendMessageBubble("user", text, true);
  if (input) input.value = "";

  setLoading(true);
  chatHistory.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await getGeminiReply();
    setLoading(false);

    appendMessageBubble("lucia", reply, true);
    chatHistory.push({ role: "model", parts: [{ text: reply }] });
  } catch (e) {
    setLoading(false);
    appendMessageBubble("lucia", "Disculpe, tuve un problema técnico. ¿Podría intentar de nuevo?", true);
  }
}
window.sendMessage = sendMessage;

/** =========================
 *  Admin login / views
 *  ========================= */
window.openLoginModal = () => {
  const modal = $("login-modal");
  modal?.classList.remove("hidden");
  modal?.classList.add("flex");
};
window.closeLoginModal = () => {
  const modal = $("login-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
};
window.performLogin = async () => {
  const email = safeText($("admin-email")?.value).trim();
  const pass = safeText($("admin-pass")?.value);
  const errorMsg = $("login-error");

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.closeLoginModal();
    switchView("admin");
  } catch (e) {
    if (errorMsg) {
      errorMsg.innerText = "Credenciales incorrectas";
      errorMsg.classList.remove("hidden");
    }
  }
};
window.logoutAdmin = async () => {
  await signOut(auth);
  await signInAnonymously(auth);
  switchView("client");
};

window.switchView = (v) => {
  $("admin-view")?.classList.toggle("view-hidden", v !== "admin");
  $("client-view")?.classList.toggle("view-hidden", v === "admin");
  if (v === "admin") {
    $("admin-view")?.classList.add("flex");
    loadLeads();
    window.showAdminTab("leads");
  }
};

window.showAdminTab = (t) => {
  $("section-leads")?.classList.toggle("hidden", t !== "leads");
  $("section-training")?.classList.toggle("hidden", t !== "training");

  if ($("nav-leads"))
    $("nav-leads").className =
      t === "leads"
        ? "text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold"
        : "text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors";

  if ($("nav-training"))
    $("nav-training").className =
      t === "training"
        ? "text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold"
        : "text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors";
};

/** =========================
 *  Settings prompt
 *  ========================= */
async function loadSettings() {
  const backupPrompt = localStorage.getItem("lucia_brain_backup_v2");

  try {
    const snap = await getDoc(
      doc(db, "artifacts", appId, "public", "data", "settings", "config")
    );
    if (snap.exists()) currentSystemPrompt = snap.data().prompt || DEFAULT_PROMPT;
    else currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
  } catch (e) {
    currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
  }

  if ($("prompt-editor")) $("prompt-editor").value = currentSystemPrompt;
}

window.savePrompt = async () => {
  if (!isAdmin) { showToast("No autorizado"); return; }

  const val = safeText($("prompt-editor")?.value);
  currentSystemPrompt = val;
  localStorage.setItem("lucia_brain_backup_v2", val);

  try {
    await setDoc(
      doc(db, "artifacts", appId, "public", "data", "settings", "config"),
      { prompt: val },
      { merge: true }
    );
    showToast("Configuración guardada");
  } catch (e) {
    showToast("Guardado local (falló nube)");
  }
};

/** =========================
 *  Admin leads dashboard
 *  ========================= */
function escapeHtml(str) {
  return safeText(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLeadsTable() {
  const tbody = $("leads-table-body");
  const emptyState = $("empty-state");
  const badge = $("badge-hot");
  if (!tbody) return;

  tbody.innerHTML = "";

  // Solo los que hicieron click en reservar
  const filtered = allLeadsCache.filter((l) => l.status === "📅 RESERVA");

  if (emptyState) {
    if (filtered.length === 0) emptyState.classList.remove("hidden");
    else emptyState.classList.add("hidden");
  }

  if (badge) {
    if (filtered.length > 0) {
      badge.innerText = String(filtered.length);
      badge.classList.remove("hidden");
    } else badge.classList.add("hidden");
  }

  filtered.forEach((l) => {
    const ts =
      l.bookingClickedAt?.seconds ? l.bookingClickedAt.seconds * 1000 :
      l.updatedAt?.seconds ? l.updatedAt.seconds * 1000 :
      Date.now();

    const d = new Date(ts).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    let name = l.extractedName || "Prospecto";
    if (name.length > 28) name = "Prospecto";

    tbody.innerHTML += `
      <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="p-4 text-[11px] text-gray-400 font-mono">${d}</td>
        <td class="p-4 font-bold text-sm text-slate-700">${escapeHtml(name)}</td>
        <td class="p-4 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg w-fit px-2 py-1 inline-block">Reserva</td>
        <td class="p-4 text-right">
          <button onclick="openDetailModal('${l.id}')" class="text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">
            Ver Ficha
          </button>
        </td>
      </tr>
    `;
  });
}

function loadLeads() {
  if (!isAdmin) return;
  try {
    onSnapshot(
      collection(db, "artifacts", appId, "public", "data", "leads"),
      (snap) => {
        const data = [];
        snap.forEach((d) => data.push({ id: d.id, ...d.data() }));
        allLeadsCache = data.sort(
          (a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0)
        );
        renderLeadsTable();
      },
      (err) => console.warn("Error cargando leads:", err)
    );
  } catch (e) {
    console.warn("Error snapshot leads:", e);
  }
}

window.manualRefresh = () => { if (!isAdmin) return; loadLeads(); showToast("Datos actualizados"); };

/** =========================
 *  Lead detail modal
 *  ========================= */
window.openDetailModal = async (id) => {
  const modal = $("lead-detail-modal");
  modal?.classList.remove("hidden");
  modal?.classList.add("flex");

  let data = allLeadsCache.find((l) => l.id === id);
  if (!data) {
    const s = await getDoc(doc(db, "artifacts", appId, "public", "data", "leads", id));
    if (s.exists()) data = { id: s.id, ...s.data() };
  }
  if (!data) return;

  if ($("detail-summary")) $("detail-summary").innerText = data.summary || "Sin resumen";

  if (data.history && $("detail-history")) {
    $("detail-history").innerHTML = Object.values(data.history)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map(
        (m) =>
          `<div class="mb-2"><span class="font-bold ${
            m.role === "lucia" ? "text-blue-600" : "text-gray-800"
          }">${m.role === "lucia" ? "Lucía" : "Cliente"}:</span> ${escapeHtml(m.text)}</div>`
      )
      .join("");
  }

  const callBtn = $("call-btn");
  const phoneEl = $("detail-phone");
  const contactInfo = $("contact-info");

  if (data.phone) {
    if (callBtn) {
      callBtn.innerHTML = `📞 Llamar a ${escapeHtml(data.phone)}`;
      callBtn.classList.remove("opacity-50", "cursor-not-allowed");
      callBtn.onclick = () => window.open(`tel:${data.phone}`);
    }
    if (phoneEl) phoneEl.innerText = data.phone;
    contactInfo?.classList.remove("hidden");
  } else {
    if (callBtn) {
      callBtn.innerHTML = "📞 Número No Disponible";
      callBtn.classList.add("opacity-50", "cursor-not-allowed");
    }
    contactInfo?.classList.add("hidden");
  }
};

window.closeDetailModal = () => {
  $("lead-detail-modal")?.classList.add("hidden");
  $("lead-detail-modal")?.classList.remove("flex");
};
window.toggleHistory = () => $("detail-history")?.classList.toggle("hidden");

/** =========================
 *  INIT
 *  ========================= */
function init() {
  app = initializeApp(myFirebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  $("chat-form")?.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
  $("login-form")?.addEventListener("submit", (e) => { e.preventDefault(); window.performLogin(); });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      await signInAnonymously(auth);
      return;
    }

    currentUser = user;
    isAdmin = !!user.email && user.email.toLowerCase() === ADMIN_EMAIL;

    await loadSettings();
    await ensureLeadExists();

    isReady = true; // ✅ ya puede enviar mensajes
  });

  // iniciar auth
  signInAnonymously(auth).catch(() => {});
}

init();
