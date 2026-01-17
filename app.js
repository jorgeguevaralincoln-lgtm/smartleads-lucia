// app.js (ES MODULE) — SIMPLE: IA + Leads + Botón WhatsApp + Resumen al click
// - Sin Google Calendar
// - Lucía muestra botón WhatsApp cuando el prompt incluya [WHATSAPP]
// - Al click: genera resumen (IA) -> guarda en Firestore -> abre WhatsApp

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
 *  CONFIG (SOLO LO ESENCIAL)
 *  ========================= */

const ADMIN_EMAIL = "asistentedebeneficios@gmail.com";
const WHATSAPP_PHONE_E164 = "14079553077"; // +1 407 955 3077

// Gemini API key (como lo tenías)
const P1 = "AIzaSyCjhXpHtovaqye6";
const P2 = "O4r2ir2tT5lksOIrNfs";
const API_KEY = P1 + P2;

// Endpoint Gemini (v1beta) — docs oficiales
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Usa un modelo estable. Si por alguna razón tu key no tiene acceso, cambia aquí.
const GEMINI_MODEL = "gemini-2.0-flash";

// AppId usado en tus rutas Firestore
const APP_ID = "smartleads-prod";

// Firebase config (igual al tuyo)
const myFirebaseConfig = {
  apiKey: "AIzaSyA_-x6UEEVEJ7uAY8ohCrDussZ938QQ0B0",
  authDomain: "luciaai-46c75.firebaseapp.com",
  projectId: "luciaai-46c75",
  storageBucket: "luciaai-46c75.firebasestorage.app",
  messagingSenderId: "56311029362",
  appId: "1:56311029362:web:2a09107f6c6f3a7b3ceceb",
  measurementId: "G-KRMZBRX3JQ",
};

// session lead id (por sesión)
const sessionId = crypto.randomUUID();

/** =========================
 *  HELPERS UI
 *  ========================= */

const el = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(msg) {
  const toast = el("toast");
  if (!toast) return;
  toast.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
    </svg>
    <span>${escapeHtml(msg || "Actualizado")}</span>
  `;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}
window.showToast = showToast;

/** =========================
 *  FIREBASE INIT
 *  ========================= */

let app, auth, db;
let currentUser = null;

app = initializeApp(myFirebaseConfig);
auth = getAuth(app);
db = getFirestore(app);

/** =========================
 *  STATE
 *  ========================= */

let currentSystemPrompt = "";
let chatHistoryForGemini = []; // [{role:'user'|'model', parts:[{text}]}]
let allLeadsCache = [];

// Prompt por defecto (solo si no hay settings guardados)
const DEFAULT_PROMPT = `
CEREBRO DE LUCÍA (DEFAULT)

- Usted es Lucía, Asistente de beneficios (Gastos Finales).
- Sea calmada, amable, sin presión. Siempre use “Usted”.
- Mensajes cortos (2–3 líneas).
- Responda preguntas con calma.

REGLA DE BOTÓN:
- SOLO muestre el botón WhatsApp cuando usted incluya exactamente: [WHATSAPP]
- Use [WHATSAPP] cuando el usuario diga: “quiero una cita”, “quiero hablar”, “quiero agendar”, “quiero contacto”.

Cuando use [WHATSAPP], diga:
“Perfecto. Para hablar con un Licenciado acreditado, presione el botón de WhatsApp.”
[WHATSAPP]
`;

/** =========================
 *  DOC REFS
 *  ========================= */

function leadRef() {
  return doc(db, "artifacts", APP_ID, "public", "data", "leads", sessionId);
}

function settingsRef() {
  return doc(db, "artifacts", APP_ID, "public", "data", "settings", "config");
}

/** =========================
 *  AUTH
 *  ========================= */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    await safeAnonLogin();
    return;
  }

  currentUser = user;

  // cargar cerebro
  await loadSettings();

  // asegurar lead doc con userId desde el inicio
  await ensureLeadExists();

  // bind UI
  bindUI();
});

async function safeAnonLogin() {
  try {
    await signInAnonymously(auth);
  } catch (e) {
    console.error("Anonymous auth failed:", e);
  }
}

/** =========================
 *  SETTINGS (CEREBRO)
 *  ========================= */

async function loadSettings() {
  const backup = localStorage.getItem("lucia_brain_backup_simple_v1");
  try {
    const snap = await getDoc(settingsRef());
    if (snap.exists() && snap.data()?.prompt) {
      currentSystemPrompt = snap.data().prompt;
    } else {
      currentSystemPrompt = backup || DEFAULT_PROMPT;
    }
  } catch (e) {
    currentSystemPrompt = backup || DEFAULT_PROMPT;
  }

  const editor = el("prompt-editor");
  if (editor) editor.value = currentSystemPrompt;
}

async function savePrompt() {
  const editor = el("prompt-editor");
  const val = editor ? editor.value : "";
  if (!val) return;

  localStorage.setItem("lucia_brain_backup_simple_v1", val);
  currentSystemPrompt = val;

  try {
    await setDoc(
      settingsRef(),
      { prompt: val, updatedAt: serverTimestamp(), updatedBy: currentUser?.email || null },
      { merge: true }
    );
    showToast("Cerebro guardado ✅");
  } catch (e) {
    console.error("savePrompt error:", e);
    showToast("Guardado local (sin permisos nube)");
  }
}
window.savePrompt = savePrompt;

/** =========================
 *  LEADS (GUARDADO)
 *  ========================= */

async function ensureLeadExists() {
  if (!currentUser) return;
  try {
    await setDoc(
      leadRef(),
      {
        userId: currentUser.uid,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessage: "Sesión iniciada",
        status: "Navegando",
      },
      { merge: true }
    );
  } catch (e) {
    console.error("ensureLeadExists error:", e);
  }
}

async function saveMessage(txt, role, extra = {}) {
  if (!currentUser) return;

  const payload = {
    userId: currentUser.uid,
    updatedAt: serverTimestamp(),
    lastMessage: txt,
    [`history.${Date.now()}`]: { role, text: txt, ts: Date.now() },
    ...extra,
  };

  try {
    await updateDoc(leadRef(), payload);
  } catch (e) {
    // fallback
    try {
      await setDoc(leadRef(), payload, { merge: true });
    } catch (err) {
      console.error("Error guardando msg:", err);
    }
  }
}

/** =========================
 *  ADMIN: LEADS LIST
 *  ========================= */

function loadLeads() {
  try {
    onSnapshot(
      collection(db, "artifacts", APP_ID, "public", "data", "leads"),
      (snap) => {
        const data = [];
        snap.forEach((d) => data.push({ id: d.id, ...d.data() }));
        allLeadsCache = data.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
        renderLeadsTable();
      },
      (err) => console.warn("Error cargando leads:", err)
    );
  } catch (e) {
    console.warn("Error snapshot leads:", e);
  }
}
window.manualRefresh = () => {
  loadLeads();
  showToast("Datos actualizados");
};

function renderLeadsTable() {
  const tbody = el("leads-table-body");
  const emptyState = el("empty-state");
  if (!tbody) return;

  tbody.innerHTML = "";

  // Mostrar: solo los que hicieron click a WhatsApp o tienen resumen
  const filtered = allLeadsCache.filter((l) => {
    const hasSummary = (l.summary && l.summary.length > 10) || (l.extractedSummary && l.extractedSummary.length > 10);
    const wants = !!l.whatsappClickedAt || String(l.status || "").includes("📲");
    return hasSummary || wants;
  });

  if (filtered.length === 0) emptyState?.classList.remove("hidden");
  else emptyState?.classList.add("hidden");

  const hotCount = allLeadsCache.filter((l) => !!l.whatsappClickedAt || String(l.status || "").includes("📲")).length;
  const badge = el("badge-hot");
  if (badge) {
    if (hotCount > 0) {
      badge.innerText = hotCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  filtered.forEach((l) => {
    const ms = l.updatedAt?.seconds ? l.updatedAt.seconds * 1000 : Date.now();
    const d = new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    const name = l.extractedName || "Prospecto";
    const interes = (String(l.summary || l.extractedSummary || "").toLowerCase().includes("gastos") ? "Gastos Finales" : "General");

    tbody.innerHTML += `
      <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="p-4 text-[11px] text-gray-400 font-mono">${escapeHtml(d)}</td>
        <td class="p-4 font-bold text-sm text-slate-700">${escapeHtml(name)}</td>
        <td class="p-4 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg w-fit px-2 py-1 inline-block">${escapeHtml(interes)}</td>
        <td class="p-4 text-right">
          <button onclick="openDetailModal('${l.id}')" class="text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">
            Ver Ficha
          </button>
        </td>
      </tr>
    `;
  });
}

async function openDetailModal(id) {
  el("lead-detail-modal")?.classList.remove("hidden");
  el("lead-detail-modal")?.classList.add("flex");

  let data = allLeadsCache.find((l) => l.id === id);
  if (!data) {
    const s = await getDoc(doc(db, "artifacts", APP_ID, "public", "data", "leads", id));
    if (s.exists()) data = s.data();
  }
  if (!data) return;

  el("detail-summary").innerText = data.summary || data.extractedSummary || "Sin resumen aún.";

  // history
  if (data.history && el("detail-history")) {
    const arr = Object.values(data.history).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    el("detail-history").innerHTML = arr
      .map(
        (m) =>
          `<div class="mb-2"><span class="font-bold ${m.role === "lucia" ? "text-blue-600" : "text-gray-800"}">${
            m.role === "lucia" ? "Lucía" : "Cliente"
          }:</span> ${escapeHtml(m.text)}</div>`
      )
      .join("");
  }

  // call button
  const phone = data.phone || data.extractedPhone || null;
  const callBtn = el("call-btn");
  if (phone) {
    callBtn.innerHTML = `📞 Llamar a ${escapeHtml(phone)}`;
    callBtn.classList.remove("opacity-50", "cursor-not-allowed");
    callBtn.onclick = () => window.open(`tel:${phone}`);
    el("detail-phone").innerText = phone;
    el("contact-info")?.classList.remove("hidden");
  } else {
    callBtn.innerHTML = "📞 Número No Disponible";
    callBtn.classList.add("opacity-50", "cursor-not-allowed");
    el("contact-info")?.classList.add("hidden");
  }
}
window.openDetailModal = openDetailModal;

window.closeDetailModal = () => {
  el("lead-detail-modal")?.classList.add("hidden");
  el("lead-detail-modal")?.classList.remove("flex");
};

window.toggleHistory = () => el("detail-history")?.classList.toggle("hidden");

/** =========================
 *  ADMIN LOGIN + VIEW SWITCH
 *  ========================= */

function openLoginModal() {
  // Si ya es admin (email correcto), entra directo
  if (currentUser?.email && currentUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
    switchView("admin");
    return;
  }
  el("login-modal")?.classList.remove("hidden");
  el("login-modal")?.classList.add("flex");
}
window.openLoginModal = openLoginModal;

window.closeLoginModal = () => {
  el("login-modal")?.classList.add("hidden");
  el("login-modal")?.classList.remove("flex");
};

async function performLogin() {
  const email = el("admin-email")?.value?.trim();
  const pass = el("admin-pass")?.value?.trim();
  const errorMsg = el("login-error");

  if (!email || !pass) {
    errorMsg.innerText = "Ingrese correo y contraseña.";
    errorMsg.classList.remove("hidden");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);

    const u = auth.currentUser;
    if (!u?.email || u.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      await signOut(auth);
      errorMsg.innerText = "Este usuario no tiene permisos de Admin.";
      errorMsg.classList.remove("hidden");
      return;
    }

    errorMsg.classList.add("hidden");
    window.closeLoginModal();
    switchView("admin");
  } catch (e) {
    errorMsg.innerText = "Credenciales incorrectas.";
    errorMsg.classList.remove("hidden");
  }
}
window.performLogin = performLogin;

window.logoutAdmin = async () => {
  try {
    await signOut(auth);
  } catch {}
  await safeAnonLogin();
  switchView("client");
};

function switchView(v) {
  el("admin-view")?.classList.toggle("view-hidden", v !== "admin");
  el("client-view")?.classList.toggle("view-hidden", v === "admin");
  if (v === "admin") {
    el("admin-view")?.classList.add("flex");
    loadLeads();
    showAdminTab("leads");
  }
}
window.switchView = switchView;

function showAdminTab(t) {
  el("section-leads")?.classList.toggle("hidden", t !== "leads");
  el("section-training")?.classList.toggle("hidden", t !== "training");

  if (el("nav-leads")) {
    el("nav-leads").className =
      t === "leads"
        ? "text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold"
        : "text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors";
  }
  if (el("nav-training")) {
    el("nav-training").className =
      t === "training"
        ? "text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold"
        : "text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors";
  }
}
window.showAdminTab = showAdminTab;

/** =========================
 *  CHAT UI
 *  ========================= */

function appendMessageBubble(role, text, shouldSave = true) {
  const chatBox = el("chat-box");
  if (!chatBox) return;

  const hasWhatsAppTag = role === "lucia" && String(text || "").includes("[WHATSAPP]");
  const cleanText = String(text || "").replace("[WHATSAPP]", "").trim();

  const div = document.createElement("div");
  div.className = `bubble ${role} shadow-sm`;
  div.innerHTML = escapeHtml(cleanText).replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  chatBox.appendChild(div);

  // Si Lucía activó WhatsApp, ponemos el botón Apple verde (tu ws-button)
  if (hasWhatsAppTag) {
    const btn = document.createElement("div");
    btn.className = "ws-button";
    btn.innerHTML = "<span>Contactar por WhatsApp</span>";

    btn.onclick = async () => {
      btn.style.opacity = "0.7";
      btn.style.pointerEvents = "none";
      await finalizeAndOpenWhatsApp(cleanText);
    };

    chatBox.appendChild(btn);
  }

  div.scrollIntoView({ behavior: "smooth" });

  if (shouldSave) saveMessage(cleanText, role).catch(() => {});
}

async function finalizeAndOpenWhatsApp(lastLuciaText) {
  try {
    showToast("Guardando resumen...");
    const summaryPack = await analyzeLead();

    // Guardar que dio click WhatsApp + resumen + status
    await saveMessage("CLICK_WHATSAPP", "system", {
      status: "📲 QUIERE CITA",
      whatsappClickedAt: serverTimestamp(),
      summary: summaryPack.summary,
      extractedName: summaryPack.name || null,
      extractedAge: summaryPack.age || null,
      extractedState: summaryPack.state || null,
      extractedPhone: summaryPack.phone || null,
    });

    showToast("Listo ✅ Abriendo WhatsApp");

    const prefilled = encodeURIComponent("Hola, vengo de Lucía (Asistente de Beneficios). Quisiera agendar una cita.");
    window.open(`https://wa.me/${WHATSAPP_PHONE_E164}?text=${prefilled}`, "_blank");
  } catch (e) {
    console.error("finalizeAndOpenWhatsApp error:", e);
    showToast("No pude guardar el resumen (revisar Rules)");
    // Aun así abre WhatsApp
    const prefilled = encodeURIComponent("Hola, vengo de Lucía (Asistente de Beneficios). Quisiera agendar una cita.");
    window.open(`https://wa.me/${WHATSAPP_PHONE_E164}?text=${prefilled}`, "_blank");
  }
}

/** =========================
 *  IA (GEMINI)
 *  ========================= */

// Llamada a Gemini generateContent (v1beta)
async function geminiGenerate(systemPrompt, contents) {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 350,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return text.trim();
}

// Resume el lead al final
async function analyzeLead() {
  const prompt = `
Analiza el chat y extrae datos en JSON estricto.
Devuelve SOLO JSON válido, sin markdown, sin texto extra:

{
  "name": "nombre o null",
  "age": "edad (numero) o null",
  "state": "estado o null",
  "phone": "telefono/whatsapp o null",
  "summary": "resumen corto: motivo, familia, salud, presupuesto si se menciono, y que quiere cita"
}

Reglas:
- Si no aparece un dato, usa null.
- El resumen debe ser de 2-4 lineas, claro y útil para el Licenciado.
`;

  // Construir "contents" con el historial REAL
  const contents = [...chatHistoryForGemini];

  // Si no hay historial suficiente, igual responde
  const text = await geminiGenerate(prompt, contents);

  try {
    return JSON.parse(text);
  } catch {
    // fallback si Gemini devuelve texto no-JSON
    return {
      name: null,
      age: null,
      state: null,
      phone: null,
      summary: "Prospecto solicitó contacto por WhatsApp. (No se pudo parsear resumen automático.)",
    };
  }
}

/** =========================
 *  CHAT FLOW
 *  ========================= */

async function sendMessage(manualText = null) {
  const input = el("user-input");
  const loading = el("loading");

  const text = (manualText || input?.value || "").trim();
  if (!text) return;

  appendMessageBubble("user", text, true);
  if (input) input.value = "";

  loading?.classList.remove("hidden");

  // Gemini history
  chatHistoryForGemini.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await geminiGenerate(currentSystemPrompt, chatHistoryForGemini);

    loading?.classList.add("hidden");
    appendMessageBubble("lucia", reply, true);

    chatHistoryForGemini.push({ role: "model", parts: [{ text: reply }] });
  } catch (e) {
    loading?.classList.add("hidden");
    console.error(e);
    appendMessageBubble("lucia", "Disculpe, tuve un inconveniente técnico. ¿Podría intentar de nuevo?", false);
  }
}
window.sendMessage = sendMessage;

/** =========================
 *  BIND UI ONCE
 *  ========================= */

let bound = false;
function bindUI() {
  if (bound) return;
  bound = true;

  el("chat-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  el("login-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    performLogin();
  });
}
