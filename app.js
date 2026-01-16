import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, updateDoc, serverTimestamp,
  collection, onSnapshot, getDoc
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/** =========================
 *  CONFIG
 *  ========================= */
const ADMIN_EMAIL = "asistentedebeneficios@gmail.com";

// ✅ MODELO VIGENTE
const GEMINI_MODEL = "gemini-2.5-flash-lite"; // rápido y estable
// const GEMINI_MODEL = "gemini-2.5-flash";   // alternativa

// Google Apps Script /exec
const BOOKING_ENDPOINT = "https://script.google.com/macros/s/AKfycbwuxlLMkxyNpoXK81b1Xeqkn-LiDqdnV3z5T8UIyHJYYaIeV9jt-yhbrXBRbll5G_zc1Q/exec";
const BOOKING_TOKEN = "sl_2026_seguro_89xK2P"; // ✅ TU TOKEN

const MEETING_MINUTES = 20;

// Zona horaria real del prospecto (auto)
const PROSPECT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";

// WhatsApp del licenciado
const LIC_PHONE = "14079553077";

// Gemini key (igual que tu código original)
const P1 = "AIzaSyCjhXpHtovaqye6"; const P2 = "O4r2ir2tT5lksOIrNfs";
const API_KEY = P1 + P2;

// Firebase config
const myFirebaseConfig = {
  apiKey: "AIzaSyA_-x6UEEVEJ7uAY8ohCrDussZ938QQ0B0",
  authDomain: "luciaai-46c75.firebaseapp.com",
  projectId: "luciaai-46c75",
  storageBucket: "luciaai-46c75.firebasestorage.app",
  messagingSenderId: "56311029362",
  appId: "1:56311029362:web:2a09107f6c6f3a7b3ceceb",
  measurementId: "G-KRMZBRX3JQ"
};

const sessionId = crypto.randomUUID();

let db, app, auth, appId;
let currentUser = null;

let chatHistory = [];
let currentSystemPrompt = "";
let allLeadsCache = [];

let awaitingAppointment = false;
let pendingSuggestions = [];

/** =========================
 *  PROMPT
 *  ========================= */
const DEFAULT_PROMPT = `
Nombre: Lucía.
Rol: Asistente de beneficios (Gastos Finales).
Tono: Respetuoso, breve, tranquilo. Use siempre "Usted". Sin presión. Permita preguntas.

Objetivo: Educar y orientar. Cuando el prospecto esté listo, invitar a agendar una cita con un Licenciado acreditado (no usted).

Cuando el prospecto diga que desea agendar/reservar:
Pregunte EXACTAMENTE:
"Perfecto. ¿Qué día y a qué hora le conviene para una llamada corta?"
y al final agregue: [AGENDAR_CITA]

Botones SOLO si el admin los escribe con [BOTONES: ...]
`;

/** =========================
 *  INIT FIREBASE
 *  ========================= */
app = initializeApp(myFirebaseConfig);
auth = getAuth(app);
db = getFirestore(app);
appId = "smartleads-prod";

/** =========================
 *  UI helpers
 *  ========================= */
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (msg) {
    toast.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
      </svg>
      ${msg}
    `;
  }
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
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

function setLoading(on) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.toggle('hidden', !on);
}

function appendButtonsFromTextIfAny(cleanText) {
  const regex = /\[BOTONES:\s*(.*?)\]/i;
  const match = cleanText.match(regex);
  if (!match) return { cleanText, buttons: null };

  const buttons = match[1].split(',').map(s => s.replace(/[\*\_\[\]]/g, '').trim());
  cleanText = cleanText.replace(regex, "").trim();
  return { cleanText, buttons };
}

function appendMessageBubble(role, text, shouldSave = true) {
  const wantsBooking = (text || "").includes("[AGENDAR_CITA]");
  let cleanText = (text || "").replace("[AGENDAR_CITA]", "").trim();

  let buttons = null;
  if (role === "lucia") {
    const parsed = appendButtonsFromTextIfAny(cleanText);
    cleanText = parsed.cleanText;
    buttons = parsed.buttons;
  }

  const div = document.createElement('div');
  div.className = `bubble ${role} shadow-sm`;
  div.innerHTML = cleanText
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');

  document.getElementById('chat-box').appendChild(div);

  if (buttons && buttons.length) {
    const container = document.createElement('div');
    container.className = "quick-actions-container";
    buttons.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = "quick-btn";
      btn.innerText = opt;
      btn.onclick = () => {
        container.remove();
        sendMessage(opt);
      };
      container.appendChild(btn);
    });
    document.getElementById('chat-box').appendChild(container);
  }

  div.scrollIntoView({ behavior: "smooth" });

  if (wantsBooking) {
    awaitingAppointment = true;
    pendingSuggestions = [];
  }

  if (shouldSave) saveMessage(cleanText, role);
}

/** =========================
 *  AUTH / BOOT
 *  ========================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    await signInAnonymously(auth);
    return;
  }

  currentUser = user;

  // Crear lead base con userId para rules
  try {
    await setDoc(
      doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId),
      {
        userId: user.uid,
        startedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessage: "Sesión iniciada",
        status: "Navegando",
        summary: "Pendiente..."
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("No se pudo crear lead base:", e);
  }

  await loadSettings();
});

/** =========================
 *  Admin modal
 *  ========================= */
window.openLoginModal = () => {
  const modal = document.getElementById('login-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  err.innerText = "";
};

window.closeLoginModal = () => {
  const modal = document.getElementById('login-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
};

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('admin-email').value.trim();
  const pass = document.getElementById('admin-pass').value;
  const errorMsg = document.getElementById('login-error');

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.closeLoginModal();
    switchView("admin");
  } catch (err) {
    errorMsg.innerText = "Credenciales incorrectas";
    errorMsg.classList.remove('hidden');
  }
});

window.logoutAdmin = async () => {
  await signOut(auth);
  await signInAnonymously(auth);
  switchView("client");
};

/** =========================
 *  Views
 *  ========================= */
function switchView(v) {
  document.getElementById('admin-view').classList.toggle('view-hidden', v !== 'admin');
  document.getElementById('client-view').classList.toggle('view-hidden', v === 'admin');

  if (v === "admin") {
    document.getElementById('admin-view').classList.add('flex');
    loadLeads();
    loadSettings();
  }
}
window.switchView = switchView;

window.showAdminTab = (t) => {
  document.getElementById('section-leads').classList.toggle('hidden', t !== 'leads');
  document.getElementById('section-training').classList.toggle('hidden', t !== 'training');

  document.getElementById('nav-leads').className =
    t === 'leads' ? 'text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold'
                 : 'text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors';

  document.getElementById('nav-training').className =
    t === 'training' ? 'text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold'
                     : 'text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors';
};

/** =========================
 *  SETTINGS (Prompt)
 *  ========================= */
async function loadSettings() {
  const backupPrompt = localStorage.getItem('lucia_brain_backup_v2');

  try {
    const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'));
    if (snap.exists()) currentSystemPrompt = snap.data().prompt || DEFAULT_PROMPT;
    else currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
  } catch {
    currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
  }

  const editor = document.getElementById('prompt-editor');
  if (editor) editor.value = currentSystemPrompt;
}

window.savePrompt = async () => {
  const val = document.getElementById('prompt-editor').value;
  currentSystemPrompt = val;
  localStorage.setItem('lucia_brain_backup_v2', val);

  try {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'), { prompt: val }, { merge: true });
    showToast("Prompt guardado correctamente");
  } catch (e) {
    console.error(e);
    showToast("Guardado local (falló nube)");
  }
};

/** =========================
 *  Leads Dashboard
 *  ========================= */
function renderLeadsTable() {
  const tbody = document.getElementById('leads-table-body');
  const emptyState = document.getElementById('empty-state');
  tbody.innerHTML = "";

  const filtered = allLeadsCache.filter(l =>
    l.status === "CITA_CONFIRMADA" || l.status === "CITA_SOLICITADA"
  );

  if (!filtered.length) emptyState.classList.remove("hidden");
  else emptyState.classList.add("hidden");

  const badge = document.getElementById('badge-hot');
  if (filtered.length) { badge.innerText = filtered.length; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");

  filtered.forEach(l => {
    const updatedMs = l.updatedAt?.seconds ? l.updatedAt.seconds * 1000 : Date.now();
    const d = new Date(updatedMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const name = l.extractedName || "Prospecto";
    const appt = l.appointmentStart ? new Date(l.appointmentStart).toLocaleString() : "Pendiente";

    tbody.innerHTML += `
      <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="p-4 text-[11px] text-gray-400 font-mono">${d}</td>
        <td class="p-4 font-bold text-sm text-slate-700">${name}</td>
        <td class="p-4 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg w-fit px-2 py-1 inline-block">${appt}</td>
        <td class="p-4 text-right">
          <button onclick="openDetailModal('${l.id}')" class="text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">
            Ver Ficha
          </button>
        </td>
      </tr>`;
  });
}

function loadLeads() {
  try {
    onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'leads'), snap => {
      const data = [];
      snap.forEach(d => data.push({ id: d.id, ...d.data() }));
      allLeadsCache = data.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
      renderLeadsTable();
    });
  } catch (e) {
    console.warn("Error snapshot leads", e);
  }
}
window.manualRefresh = () => { loadLeads(); showToast("Datos Actualizados"); };

/** =========================
 *  Lead Detail Modal
 *  ========================= */
window.openDetailModal = async (id) => {
  document.getElementById('lead-detail-modal').classList.remove('hidden');
  document.getElementById('lead-detail-modal').classList.add('flex');

  let data = allLeadsCache.find(l => l.id === id);
  if (!data) {
    const s = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', id));
    if (s.exists()) data = s.data();
  }

  if (data) {
    document.getElementById('detail-summary').innerText = data.summary || "Sin resumen";

    if (data.history) {
      document.getElementById('detail-history').innerHTML = Object.values(data.history)
        .sort((a, b) => a.ts - b.ts)
        .map(m => `<div class="mb-2"><span class="font-bold ${m.role === 'lucia' ? 'text-blue-600' : 'text-gray-800'}">${m.role === 'lucia' ? 'Lucía' : 'Cliente'}:</span> ${m.text}</div>`)
        .join('');
    }

    const callBtn = document.getElementById('call-btn');
    if (data.phone) {
      callBtn.innerHTML = `📞 Llamar a ${data.phone}`;
      callBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      callBtn.onclick = () => window.open(`tel:${data.phone}`);
      document.getElementById('detail-phone').innerText = data.phone;
      document.getElementById('contact-info').classList.remove('hidden');
    } else {
      callBtn.innerHTML = "📞 Número No Disponible";
      callBtn.classList.add('opacity-50', 'cursor-not-allowed');
      document.getElementById('contact-info').classList.add('hidden');
    }
  }
};
window.closeDetailModal = () => {
  document.getElementById('lead-detail-modal').classList.add('hidden');
  document.getElementById('lead-detail-modal').classList.remove('flex');
};
window.toggleHistory = () => document.getElementById('detail-history').classList.toggle('hidden');
window.callProspect = () => {
  const phone = document.getElementById('detail-phone').innerText;
  if (phone && phone !== '--') window.open(`tel:${phone}`);
};

/** =========================
 *  Save message to Firestore
 *  ========================= */
async function saveMessage(txt, role, extra = {}) {
  if (!currentUser) return;

  const data = {
    userId: currentUser.uid,
    lastMessage: txt,
    [`history.${Date.now()}`]: { role, text: txt, ts: Date.now() },
    updatedAt: serverTimestamp(),
    ...extra
  };

  try {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), data);
  } catch (e) {
    console.warn("Error saving message", e);
  }
}

/** =========================
 *  Lead Summary extractor
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
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [...chatHistory, { role: "user", parts: [{ text: prompt }] }] })
    });

    if (!r.ok) return { summary: "Cita solicitada. Revisar conversación." };

    const d = await r.json();
    const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, "").trim() || "{}";
    const json = JSON.parse(raw);

    const update = {
      extractedName: json.name || null,
      extractedAge: json.age || null,
      extractedState: json.state || null,
      phone: (json.phone && json.phone !== "null") ? json.phone : null,
      extractedWhy: json.why || null,
      extractedHealth: json.health || null,
      extractedBudget: json.budget || null,
      summary: json.summary || "Cita solicitada. Revisar conversación."
    };

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), update);
    return update;

  } catch (e) {
    console.error(e);
    return { summary: "Cita solicitada. Revisar conversación." };
  }
}

/** =========================
 *  Booking call
 *  ========================= */
async function bookWithAppsScript({ name, phone, requestedText, summary, startIso = null }) {
  const payload = {
    token: BOOKING_TOKEN,
    timezone: PROSPECT_TZ,           // ✅ TZ REAL del prospecto
    meetingMinutes: MEETING_MINUTES,
    calendarId: "primary",
    name,
    phone,
    requestedText,
    summary,
    startIso
  };

  const r = await fetch(BOOKING_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return await r.json();
}

/** =========================
 *  Chat Send
 *  ========================= */
async function sendMessage(manualText = null) {
  const input = document.getElementById('user-input');
  const text = manualText || (input?.value || "").trim();
  if (!text) return;

  appendMessageBubble("user", text, true);
  if (input) input.value = "";

  // ======================
  // MODO AGENDA
  // ======================
  if (awaitingAppointment) {
    setLoading(true);

    // si responde 1 o 2
    const trimmed = text.trim();
    if (pendingSuggestions.length > 0 && (trimmed === "1" || trimmed === "2")) {
      const chosenIso = pendingSuggestions[Number(trimmed) - 1];
      pendingSuggestions = [];

      const lead = await analyzeLead();
      const name = lead.extractedName || "Prospecto";
      const phone = lead.phone || null;
      const summary = lead.summary || "Cita solicitada. Revisar conversación.";

      const result = await bookWithAppsScript({
        name, phone,
        requestedText: `Elección sugerida: ${formatIsoForUser(chosenIso)}`,
        summary,
        startIso: chosenIso
      });

      setLoading(false);

      if (result.ok && result.status === "CONFIRMED") {
        awaitingAppointment = false;

        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), {
          status: "CITA_CONFIRMADA",
          appointmentStart: result.start,
          appointmentEnd: result.end,
          appointmentEventUrl: result.eventUrl || null,
          updatedAt: serverTimestamp()
        });

        appendMessageBubble("lucia",
          `Perfecto ✅ Quedó agendado para **${formatIsoForUser(result.start)}**.\nEse día le escribiré por WhatsApp para la videollamada.`,
          true
        );
        return;
      }

      appendMessageBubble("lucia", "Ese horario se ocupó. Dígame otro día y hora (Ej: martes 3pm). [AGENDAR_CITA]", true);
      return;
    }

    // texto libre (martes 3pm)
    const lead = await analyzeLead();
    const name = lead.extractedName || "Prospecto";
    const phone = lead.phone || null;
    const summary = lead.summary || "Cita solicitada. Revisar conversación.";

    const result = await bookWithAppsScript({ name, phone, requestedText: text, summary });

    setLoading(false);

    if (result.ok && result.status === "CONFIRMED") {
      awaitingAppointment = false;
      pendingSuggestions = [];

      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), {
        status: "CITA_CONFIRMADA",
        appointmentStart: result.start,
        appointmentEnd: result.end,
        appointmentEventUrl: result.eventUrl || null,
        updatedAt: serverTimestamp()
      });

      appendMessageBubble("lucia",
        `Perfecto ✅ Quedó agendado para **${formatIsoForUser(result.start)}**.\nEse día le escribiré por WhatsApp para la videollamada.`,
        true
      );
      return;
    }

    if (result.status === "NEED_CLARIFY") {
      appendMessageBubble("lucia", `${result.message} [AGENDAR_CITA]`, true);
      return;
    }

    if (result.status === "CONFLICT" && Array.isArray(result.suggestions) && result.suggestions.length > 0) {
      pendingSuggestions = result.suggestions.slice(0, 2);

      const opt1 = pendingSuggestions[0] ? formatIsoForUser(pendingSuggestions[0]) : null;
      const opt2 = pendingSuggestions[1] ? formatIsoForUser(pendingSuggestions[1]) : null;

      let msg = `A esa hora ya tengo una cita. ¿Le sirve alguna de estas opciones?\n\n`;
      if (opt1) msg += `**1)** ${opt1}\n`;
      if (opt2) msg += `**2)** ${opt2}\n`;
      msg += `\nResponda con **1** o **2** (o dígame otro horario). [AGENDAR_CITA]`;

      appendMessageBubble("lucia", msg, true);
      return;
    }

    appendMessageBubble("lucia", "Disculpe, no pude agendar. Dígame otro día y hora (Ej: miércoles 11am). [AGENDAR_CITA]", true);
    return;
  }

  // ======================
  // MODO NORMAL (Gemini)
  // ======================
  setLoading(true);
  chatHistory.push({ role: "user", parts: [{ text }] });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${API_KEY}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: chatHistory,
        systemInstruction: { parts: [{ text: currentSystemPrompt || DEFAULT_PROMPT }] }
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("Gemini error:", r.status, errText);
      setLoading(false);
      showToast("Error IA (ver consola)");
      appendMessageBubble("lucia", "Disculpe, tuve un problema técnico. ¿Podría intentar de nuevo?", true);
      return;
    }

    const d = await r.json();
    const reply = d.candidates?.[0]?.content?.parts?.[0]?.text || "Disculpe, ¿podría repetirlo?";

    setLoading(false);
    appendMessageBubble("lucia", reply, true);
    chatHistory.push({ role: "model", parts: [{ text: reply }] });

  } catch (e) {
    console.error("Gemini fetch failed:", e);
    setLoading(false);
    showToast("Error de red IA");
    appendMessageBubble("lucia", "Disculpe, tuve un problema de conexión. ¿Podría intentar de nuevo?", true);
  }
}

window.sendMessage = sendMessage;

document.getElementById('chat-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
