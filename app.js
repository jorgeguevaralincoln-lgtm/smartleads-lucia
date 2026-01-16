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

// ✅ Modelo vigente
const GEMINI_MODEL = "gemini-2.5-flash-lite";
// const GEMINI_MODEL = "gemini-2.5-flash"; // si quieres más potencia

// Apps Script Booking
const BOOKING_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbwuxlLMkxyNpoXK81b1Xeqkn-LiDqdnV3z5T8UIyHJYYaIeV9jt-yhbrXBRbll5G_zc1Q/exec";
const BOOKING_TOKEN = "sl_2026_seguro_89xK2P";

const MEETING_MINUTES = 20;

// TZ detectada del prospecto
const PROSPECT_TZ =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";

// WhatsApp del licenciado
const LIC_PHONE = "14079553077";

// Gemini API KEY (como tu código original)
const P1 = "AIzaSyCjhXpHtovaqye6";
const P2 = "O4r2ir2tT5lksOIrNfs";
const API_KEY = P1 + P2;

// Firebase
const myFirebaseConfig = {
  apiKey: "AIzaSyA_-x6UEEVEJ7uAY8ohCrDussZ938QQ0B0",
  authDomain: "luciaai-46c75.firebaseapp.com",
  projectId: "luciaai-46c75",
  storageBucket: "luciaai-46c75.firebasestorage.app",
  messagingSenderId: "56311029362",
  appId: "1:56311029362:web:2a09107f6c6f3a7b3ceceb",
  measurementId: "G-KRMZBRX3JQ",
};

/** =========================
 *  STATE
 *  ========================= */
const sessionId = crypto.randomUUID();

let app = null;
let auth = null;
let db = null;
let appId = "smartleads-prod";
let currentUser = null;

let chatHistory = [];
let currentSystemPrompt = "";
let allLeadsCache = [];

// Agenda mode
let awaitingAppointment = false; // se activa cuando Lucía pone [AGENDAR_CITA]
let pendingSuggestions = []; // ISO list (2 opciones)

/** =========================
 *  PROMPT (fallback)
 *  ========================= */
const DEFAULT_PROMPT = `
Nombre: Lucía.
Rol: Asistente de Beneficios (Gastos Finales).
Tono: Respetuoso, breve, calmado. Use siempre "Usted". Sin presión.
Objetivo: Educar y orientar. Si el prospecto desea hablar con un Licenciado, solicitar día y hora.

REGLA DE AGENDA:
- Solo cuando el prospecto quiera una cita o el siguiente paso, pregunte EXACTAMENTE:
"Perfecto. ¿Qué día y a qué hora le conviene para una llamada corta?"
- Al final del mensaje agregue: [AGENDAR_CITA]
`;

/** =========================
 *  HELPERS: UI
 *  ========================= */
function $(id) {
  return document.getElementById(id);
}

function setLoading(on) {
  const el = $("loading");
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function showToast(msg) {
  const toast = $("toast");
  if (!toast) return;
  if (msg) {
    toast.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
      </svg>
      ${msg}
    `;
  }
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}
window.showToast = showToast;

function formatIsoForUser(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function appendButtonsIfAny(text) {
  const regex = /\[BOTONES:\s*(.*?)\]/i;
  const match = text.match(regex);
  if (!match) return { cleanText: text, buttons: null };

  const buttons = match[1]
    .split(",")
    .map((s) => s.replace(/[\*\_\[\]]/g, "").trim())
    .filter(Boolean);

  return { cleanText: text.replace(regex, "").trim(), buttons };
}

function appendMessageBubble(role, text, shouldSave = true) {
  // Detectar activación de agenda por etiqueta del modelo
  const wantsBooking = (text || "").includes("[AGENDAR_CITA]");
  let cleanText = (text || "").replace("[AGENDAR_CITA]", "").trim();

  let buttons = null;
  if (role === "lucia") {
    const parsed = appendButtonsIfAny(cleanText);
    cleanText = parsed.cleanText;
    buttons = parsed.buttons;
  }

  const div = document.createElement("div");
  div.className = `bubble ${role} shadow-sm`;
  div.innerHTML = cleanText
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");

  $("chat-box")?.appendChild(div);

  if (buttons && buttons.length) {
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

  if (wantsBooking) {
    awaitingAppointment = true;
    pendingSuggestions = [];
  }

  if (shouldSave) {
    saveMessage(cleanText, role).catch(() => {});
  }
}

/** =========================
 *  KEY FIX: Detect date/time even without [AGENDAR_CITA]
 *  (adult users write "mañana 3pm" and expect booking)
 *  ========================= */
function looksLikeDateTime(text) {
  const t = (text || "").toLowerCase();
  return /(\bhoy\b|\bmañana\b|\bmanana\b|\blunes\b|\bmartes\b|\bmi[eé]rcoles\b|\bjueves\b|\bviernes\b|\bs[áa]bado\b|\bdomingo\b|\b\d{1,2}\s*(am|pm)\b|\b\d{1,2}:\d{2}\b)/i.test(
    t
  );
}

/** =========================
 *  FIREBASE INIT
 *  ========================= */
app = initializeApp(myFirebaseConfig);
auth = getAuth(app);
db = getFirestore(app);

/** =========================
 *  AUTH + Create lead base
 *  ========================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    await signInAnonymously(auth);
    return;
  }

  currentUser = user;

  // Crear lead base para que reglas permitan update por userId
  try {
    await setDoc(
      doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
      {
        userId: user.uid,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "Navegando",
        summary: "Pendiente...",
        lastMessage: "Sesión iniciada",
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("No se pudo crear lead base:", e);
  }

  await loadSettings();
});

/** =========================
 *  ADMIN: login modal
 *  ========================= */
window.openLoginModal = () => {
  const modal = $("login-modal");
  modal?.classList.remove("hidden");
  modal?.classList.add("flex");
  const err = $("login-error");
  if (err) {
    err.classList.add("hidden");
    err.innerText = "";
  }
};

window.closeLoginModal = () => {
  const modal = $("login-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
};

$("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = ($("admin-email")?.value || "").trim();
  const pass = $("admin-pass")?.value || "";
  const err = $("login-error");

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.closeLoginModal();
    switchView("admin");
  } catch (error) {
    if (err) {
      err.innerText = "Credenciales incorrectas";
      err.classList.remove("hidden");
    }
  }
});

window.logoutAdmin = async () => {
  await signOut(auth);
  await signInAnonymously(auth);
  switchView("client");
};

/** =========================
 *  VIEWS
 *  ========================= */
function switchView(v) {
  $("admin-view")?.classList.toggle("view-hidden", v !== "admin");
  $("client-view")?.classList.toggle("view-hidden", v === "admin");

  if (v === "admin") {
    $("admin-view")?.classList.add("flex");
    loadLeads();
    loadSettings();
  }
}
window.switchView = switchView;

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

window.manualRefresh = () => {
  loadLeads();
  showToast("Datos Actualizados");
};

/** =========================
 *  SETTINGS: prompt
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
  const val = $("prompt-editor")?.value || "";
  currentSystemPrompt = val;
  localStorage.setItem("lucia_brain_backup_v2", val);

  try {
    await setDoc(
      doc(db, "artifacts", appId, "public", "data", "settings", "config"),
      { prompt: val },
      { merge: true }
    );
    showToast("Prompt guardado correctamente");
  } catch (e) {
    console.error("Error guardando prompt:", e);
    showToast("Guardado local (falló nube)");
  }
};

/** =========================
 *  LEADS: Dashboard
 *  ========================= */
function loadLeads() {
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

function renderLeadsTable() {
  const tbody = $("leads-table-body");
  const emptyState = $("empty-state");
  const badge = $("badge-hot");
  if (!tbody) return;

  tbody.innerHTML = "";

  // Mostrar solo quienes ya solicitaron/confirmaron cita
  const filtered = allLeadsCache.filter(
    (l) => l.status === "CITA_SOLICITADA" || l.status === "CITA_CONFIRMADA"
  );

  if (emptyState) {
    if (filtered.length === 0) emptyState.classList.remove("hidden");
    else emptyState.classList.add("hidden");
  }

  if (badge) {
    if (filtered.length > 0) {
      badge.innerText = String(filtered.length);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  filtered.forEach((l) => {
    const updatedMs = l.updatedAt?.seconds ? l.updatedAt.seconds * 1000 : Date.now();
    const d = new Date(updatedMs).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const name = l.extractedName || "Prospecto";
    const appt = l.appointmentStart ? formatIsoForUser(l.appointmentStart) : "Pendiente";

    tbody.innerHTML += `
      <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="p-4 text-[11px] text-gray-400 font-mono">${d}</td>
        <td class="p-4 font-bold text-sm text-slate-700">${escapeHtml(name)}</td>
        <td class="p-4 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg w-fit px-2 py-1 inline-block">${escapeHtml(appt)}</td>
        <td class="p-4 text-right">
          <button onclick="openDetailModal('${l.id}')" class="text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">
            Ver Ficha
          </button>
        </td>
      </tr>
    `;
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** =========================
 *  Lead detail modal
 *  ========================= */
window.openDetailModal = async (id) => {
  const modal = $("lead-detail-modal");
  modal?.classList.remove("hidden");
  modal?.classList.add("flex");

  let data = allLeadsCache.find((l) => l.id === id);
  if (!data) {
    const s = await getDoc(
      doc(db, "artifacts", appId, "public", "data", "leads", id)
    );
    if (s.exists()) data = { id: s.id, ...s.data() };
  }

  if (!data) return;

  if ($("detail-summary")) $("detail-summary").innerText = data.summary || "Sin resumen";

  if (data.history && $("detail-history")) {
    $("detail-history").innerHTML = Object.values(data.history)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map(
        (m) =>
          `<div class="mb-2">
             <span class="font-bold ${
               m.role === "lucia" ? "text-blue-600" : "text-gray-800"
             }">${m.role === "lucia" ? "Lucía" : "Cliente"}:</span> ${escapeHtml(
            m.text
          )}
           </div>`
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
      callBtn.innerHTML = `📞 Número No Disponible`;
      callBtn.classList.add("opacity-50", "cursor-not-allowed");
    }
    contactInfo?.classList.add("hidden");
  }
};

window.closeDetailModal = () => {
  const modal = $("lead-detail-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
};

window.toggleHistory = () => $("detail-history")?.classList.toggle("hidden");
window.callProspect = () => {
  const phone = $("detail-phone")?.innerText;
  if (phone && phone !== "--") window.open(`tel:${phone}`);
};

/** =========================
 *  Save message to Firestore
 *  ========================= */
async function saveMessage(txt, role, extra = {}) {
  if (!currentUser) return;

  const payload = {
    userId: currentUser.uid,
    lastMessage: txt,
    [`history.${Date.now()}`]: { role, text: txt, ts: Date.now() },
    updatedAt: serverTimestamp(),
    ...extra,
  };

  try {
    await updateDoc(
      doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
      payload
    );
  } catch (e) {
    console.warn("Error guardando mensaje:", e);
  }
}

/** =========================
 *  Gemini call
 *  ========================= */
async function callGemini(userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${API_KEY}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: chatHistory,
      systemInstruction: {
        parts: [{ text: currentSystemPrompt || DEFAULT_PROMPT }],
      },
    }),
  });

  if (!r.ok) {
    const err = await r.text().catch(() => "");
    console.error("Gemini error:", r.status, err);
    throw new Error("gemini_error");
  }

  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "Disculpe, ¿podría repetirlo?";
}

/** =========================
 *  Lead summary extractor (for your dashboard + calendar description)
 *  ========================= */
async function analyzeLead() {
  const prompt = `
ANALIZA el chat y devuelve JSON estricto:
{
 "name":"Nombre o null",
 "age":"Edad (solo número) o null",
 "state":"Estado o null",
 "phone":"Numero o null",
 "why":"Motivo principal (breve) o null",
 "health":"Salud/preexistencias (breve) o null",
 "budget":"Presupuesto mensual (ej 40) o null",
 "summary":"Resumen final para el licenciado (1 párrafo)."
}
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${API_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [...chatHistory, { role: "user", parts: [{ text: prompt }] }],
      }),
    });

    if (!r.ok) return { summary: "Cita solicitada. Revisar conversación." };

    const d = await r.json();
    const raw =
      d.candidates?.[0]?.content?.parts?.[0]?.text
        ?.replace(/```json|```/g, "")
        .trim() || "{}";

    const json = JSON.parse(raw);

    const update = {
      extractedName: json.name || null,
      extractedAge: json.age || null,
      extractedState: json.state || null,
      phone: json.phone && json.phone !== "null" ? json.phone : null,
      extractedWhy: json.why || null,
      extractedHealth: json.health || null,
      extractedBudget: json.budget || null,
      summary: json.summary || "Cita solicitada. Revisar conversación.",
    };

    await updateDoc(
      doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
      { ...update, updatedAt: serverTimestamp() }
    );

    return update;
  } catch (e) {
    console.error("analyzeLead error:", e);
    return { summary: "Cita solicitada. Revisar conversación." };
  }
}

/** =========================
 *  Booking: call Apps Script
 *  ========================= */
async function bookWithAppsScript({
  name,
  phone,
  requestedText,
  summary,
  startIso = null,
}) {
  const payload = {
    token: BOOKING_TOKEN,
    timezone: PROSPECT_TZ,
    meetingMinutes: MEETING_MINUTES,
    calendarId: "primary",
    name,
    phone,
    requestedText,
    summary,
    startIso,
  };

  const r = await fetch(BOOKING_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return await r.json();
}

/** =========================
 *  Main sendMessage
 *  ========================= */
async function sendMessage(manualText = null) {
  const input = $("user-input");
  const text = manualText || (input?.value || "").trim();
  if (!text) return;

  // append user
  appendMessageBubble("user", text, true);
  if (input) input.value = "";

  // push history for gemini context
  chatHistory.push({ role: "user", parts: [{ text }] });

  /**
   * ✅ KEY FIX:
   * If user writes a datetime ("mañana 3pm"), go booking flow even if awaitingAppointment is false.
   */
  const shouldTryBooking = awaitingAppointment || looksLikeDateTime(text);

  if (shouldTryBooking) {
    // enter booking mode
    awaitingAppointment = true;

    setLoading(true);

    try {
      // If user selects 1 or 2 from suggestions
      const trimmed = text.trim();
      if (pendingSuggestions.length > 0 && (trimmed === "1" || trimmed === "2")) {
        const chosenIso = pendingSuggestions[Number(trimmed) - 1];
        pendingSuggestions = [];

        // Mark lead as requested
        await saveMessage("CITA_SOLICITADA", "lucia", { status: "CITA_SOLICITADA" });

        const lead = await analyzeLead();
        const name = lead.extractedName || "Prospecto";
        const phone = lead.phone || null;
        const summary = lead.summary || "Cita solicitada. Revisar conversación.";

        const result = await bookWithAppsScript({
          name,
          phone,
          requestedText: `Elección sugerida: ${formatIsoForUser(chosenIso)}`,
          summary,
          startIso: chosenIso,
        });

        setLoading(false);

        if (result.ok && result.status === "CONFIRMED") {
          awaitingAppointment = false;

          await updateDoc(
            doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
            {
              status: "CITA_CONFIRMADA",
              appointmentStart: result.start,
              appointmentEnd: result.end,
              appointmentEventUrl: result.eventUrl || null,
              updatedAt: serverTimestamp(),
            }
          );

          appendMessageBubble(
            "lucia",
            `Perfecto ✅ Su cita quedó programada para **${formatIsoForUser(
              result.start
            )}**.\nEse día el Licenciado se comunicará con usted por WhatsApp.`,
            true
          );
          return;
        }

        appendMessageBubble(
          "lucia",
          `Ese horario se ocupó. Por favor dígame otro día y hora (Ej: martes 3pm). [AGENDAR_CITA]`,
          true
        );
        return;
      }

      // Normal booking attempt with text (e.g., "mañana 3pm")
      // Mark lead as requested
      await updateDoc(
        doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
        { status: "CITA_SOLICITADA", updatedAt: serverTimestamp() }
      );

      const lead = await analyzeLead();
      const name = lead.extractedName || "Prospecto";
      const phone = lead.phone || null;
      const summary = lead.summary || "Cita solicitada. Revisar conversación.";

      const result = await bookWithAppsScript({
        name,
        phone,
        requestedText: text,
        summary,
      });

      setLoading(false);

      if (result.ok && result.status === "CONFIRMED") {
        awaitingAppointment = false;
        pendingSuggestions = [];

        await updateDoc(
          doc(db, "artifacts", appId, "public", "data", "leads", sessionId),
          {
            status: "CITA_CONFIRMADA",
            appointmentStart: result.start,
            appointmentEnd: result.end,
            appointmentEventUrl: result.eventUrl || null,
            updatedAt: serverTimestamp(),
          }
        );

        appendMessageBubble(
          "lucia",
          `Perfecto ✅ Su cita quedó programada para **${formatIsoForUser(
            result.start
          )}**.\nEse día el Licenciado se comunicará con usted por WhatsApp.`,
          true
        );
        return;
      }

      if (result.status === "NEED_CLARIFY") {
        appendMessageBubble("lucia", `${result.message} [AGENDAR_CITA]`, true);
        return;
      }

      if (
        result.status === "CONFLICT" &&
        Array.isArray(result.suggestions) &&
        result.suggestions.length > 0
      ) {
        pendingSuggestions = result.suggestions.slice(0, 2);

        const opt1 = pendingSuggestions[0] ? formatIsoForUser(pendingSuggestions[0]) : null;
        const opt2 = pendingSuggestions[1] ? formatIsoForUser(pendingSuggestions[1]) : null;

        let msg = `En ese horario ya hay una cita.\n¿Le sirve alguna de estas opciones?\n\n`;
        if (opt1) msg += `**1)** ${opt1}\n`;
        if (opt2) msg += `**2)** ${opt2}\n`;
        msg += `\nResponda con **1** o **2** (o dígame otro horario). [AGENDAR_CITA]`;

        appendMessageBubble("lucia", msg, true);
        return;
      }

      appendMessageBubble(
        "lucia",
        `Disculpe, no pude agendar ese horario. Dígame otro día y hora (Ej: miércoles 11am). [AGENDAR_CITA]`,
        true
      );
      return;
    } catch (e) {
      console.error("booking flow error:", e);
      setLoading(false);
      showToast("Error agendando (ver consola)");
      appendMessageBubble(
        "lucia",
        "Disculpe, tuve una dificultad técnica al verificar la agenda. ¿Podría intentar nuevamente con el día y la hora?",
        true
      );
      return;
    }
  }

  // Normal mode: Gemini
  setLoading(true);
  try {
    const reply = await callGemini(text);
    setLoading(false);

    appendMessageBubble("lucia", reply, true);
    chatHistory.push({ role: "model", parts: [{ text: reply }] });
  } catch (e) {
    console.error(e);
    setLoading(false);
    showToast("Error IA (ver consola)");
    appendMessageBubble(
      "lucia",
      "Disculpe, tuve un problema técnico. ¿Podría intentar de nuevo?",
      true
    );
  }
}
window.sendMessage = sendMessage;

/** =========================
 *  Chat form submit
 *  ========================= */
$("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

/** =========================
 *  Optional: click outside modal
 *  ========================= */
document.addEventListener("click", (e) => {
  const modal = $("login-modal");
  if (!modal) return;
  if (!modal.classList.contains("hidden") && e.target === modal) {
    window.closeLoginModal();
  }
});
