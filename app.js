import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, updateDoc, serverTimestamp, collection, onSnapshot, getDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// ✅ Admin email (debe coincidir con tus Rules)
const ADMIN_EMAIL = "asistentedebeneficios@gmail.com";

const P1 = "AIzaSyCjhXpHtovaqye6";
const P2 = "O4r2ir2tT5lksOIrNfs";
const API_KEY = P1 + P2;

const JORGE_PHONE = "14079553077";
const isInCanvas = typeof __firebase_config !== 'undefined';
const MODEL_NAME = isInCanvas ? "gemini-2.5-flash-preview-09-2025" : "gemini-1.5-flash";

// SIN MEMORIA DE SESIÓN (Siempre nueva al recargar)
const sessionId = crypto.randomUUID();
localStorage.removeItem('sl_session_id');

const myFirebaseConfig = {
  apiKey: "AIzaSyA_-x6UEEVEJ7uAY8ohCrDussZ938QQ0B0",
  authDomain: "luciaai-46c75.firebaseapp.com",
  projectId: "luciaai-46c75",
  storageBucket: "luciaai-46c75.firebasestorage.app",
  messagingSenderId: "56311029362",
  appId: "1:56311029362:web:2a09107f6c6f3a7b3ceceb",
  measurementId: "G-KRMZBRX3JQ"
};

let chatHistory = [];
let currentUser = null;
let stepCount = 0;

let db, app, auth, appId;
let useLocalStorage = false;
let allLeadsCache = [];

// --- CEREBRO ---
const DEFAULT_PROMPT = `
1. IDENTIDAD Y FILTRO DE INICIO
Nombre: Lucía.
Rol: Asistente de beneficios.
Tono: Respetuoso, sutil y breve (máximo 3 líneas por mensaje). Usa siempre "Usted".
*NOTA IMPORTANTE: El mensaje de bienvenida ya se mostró en pantalla. El usuario acaba de responder SÍ o NO.*

2. FLUJO DE CONVERSACIÓN (Si responde SÍ)
Paso 1 (Respeto): Pregunta el trato preferido: “¿Cómo prefiere que le llame, Señor/Señora [Nombre] o por su nombre?”.
Paso 2 (Datos): Pide edad y código postal para "verificar programas locales".
Paso 3 (Motivo y Urgencia): Pregunta por qué desea proteger a su familia y refuerza la urgencia: “Si usted hubiera faltado ayer... ¿tendría su familia la paz económica que usted desea dejarles?”.
Paso 4 (Salud): Consulta sobre estabilidad de salud y hábitos (tabaco/crónicos) de forma amable.

3. FASE 5: EL CIERRE (GUSTITOS Y HOY)
Pregunta de Gasto: "Hablando con total confianza... ¿cuánto diría usted que se gasta al mes en pequeños 'gustitos' o cositas que a veces compramos y que no son realmente indispensables? ¿Unos $50, $80?"
El Puente: "Si de ese mismo dinero que usted ya gasta hoy, pudiéramos tomar solo una pequeña parte para que sus hijos tengan la seguridad de que todo está resuelto hoy mismo..."
Cierre Directo: "¿Habría alguna razón para no protegerse el día de hoy?"

4. MANEJO DE NEGATIVAS Y OBJECIONES
Si dice NO al inicio: Despídete educadamente: "Entiendo perfectamente. Le agradezco su tiempo y quedo a sus órdenes si en el futuro decide proteger a los suyos. ¡Que tenga un excelente día!".
Si dice NO pero pregunta después: "Comprendo su duda. Precisamente para responderle con propiedad es necesario seguir el proceso de orientación. Si cambia de opinión, aquí estaré para ayudarle."
Si dice "Tengo que hablar con mi esposa": Valida el respeto al hogar, pero recuerda que la salud de hoy es la que califica y ofrece la llamada con el Licenciado para ambos.

5. CREDIBILIDAD Y RESTRICCIONES
Autoridad: Conectas al usuario con un Licenciado acreditado por el Departamento de Servicios Financieros del Estado.
Privacidad: "Su información solo se compartirá con el Licenciado bajo su debido consentimiento".
Prohibiciones: No menciones nombres de compañías, números de póliza, ni el nombre "Jorge". El enfoque es siempre la protección para hoy.

6. REGLAS TÉCNICAS (ESTRICTAS - LEER CUIDADOSAMENTE)
- PROHIBICIÓN DE ALUCINACIÓN: JAMÁS inventes botones que no estén escritos literalmente en este prompt usando la etiqueta [BOTONES: ...]. 
- PREGUNTAS ABIERTAS: Para preguntas de Nombre, Edad, Dirección o Teléfono, ESTÁ PROHIBIDO USAR BOTONES. Deja que el usuario escriba.
- FORMATO DE BOTONES: Solo si el admin añade explícitamente [BOTONES: Opción A, Opción B] al final de una pregunta en este guion, debes mostrarlos. Si no hay etiqueta, NO hay botones.
- Lead Caliente: [CALIENTE] si hay interés alto.
- Conexión: [CONECTAR_JORGE] si acepta hablar.
`;
let currentSystemPrompt = DEFAULT_PROMPT;

// --- Init Firebase / Local fallback
try {
  if (typeof __firebase_config !== 'undefined') {
    const config = JSON.parse(__firebase_config);
    app = initializeApp(config);
    auth = getAuth(app);
    db = getFirestore(app);
    appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app';
  } else if (myFirebaseConfig && myFirebaseConfig.apiKey) {
    app = initializeApp(myFirebaseConfig);
    appId = 'smartleads-prod';
    auth = getAuth(app);
    db = getFirestore(app);
  } else {
    throw "local";
  }
} catch (e) {
  setupLocalMode();
}

function setupLocalMode() {
  useLocalStorage = true;
  currentUser = { uid: 'local', isAnonymous: true };
  saveLocalLead({ startedAt: new Date().toISOString(), lastMessage: 'Modo Local', status: 'Navegando', summary: 'Pendiente...' });
  loadSettings();
}

const initAuth = async () => {
  if (useLocalStorage) { currentUser = { uid: 'local', isAnonymous: true }; loadSettings(); return; }
  try {
    if (isInCanvas && !myFirebaseConfig.apiKey) await signInWithCustomToken(auth, __initial_auth_token);
    else await signInAnonymously(auth);
  } catch (error) {
    setupLocalMode();
  }
};

if (!useLocalStorage) {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      loadSettings();

      // ✅ FIX: al crear lead anónimo, guardar userId desde el inicio
      if (user.isAnonymous) {
        try {
          setDoc(
            doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId),
            {
              userId: user.uid,
              startedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              lastMessage: 'Sesión iniciada',
              status: 'Navegando',
              summary: 'Pendiente...'
            },
            { merge: true }
          ).catch(() => setupLocalMode());
        } catch (e) {
          setupLocalMode();
        }
      }
    } else {
      initAuth();
    }
  });
} else {
  initAuth();
}

// --- DOM listeners
document.getElementById('chat-form')?.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
document.getElementById('login-form')?.addEventListener('submit', (e) => { e.preventDefault(); performLogin(); });

// ✅ FIX: Admin SIEMPRE requiere login (se acabó la puerta trasera)
window.openLoginModal = () => {
  if (currentUser && !currentUser.isAnonymous) { switchView('admin'); return; }
  const m = document.getElementById('login-modal');
  m.classList.remove('hidden');
  m.classList.add('flex');
};

window.closeLoginModal = () => {
  const m = document.getElementById('login-modal');
  m.classList.add('hidden');
  m.classList.remove('flex');
  const err = document.getElementById('login-error');
  if (err) err.classList.add('hidden');
};

window.performLogin = async () => {
  const email = document.getElementById('admin-email')?.value || '';
  const pass = document.getElementById('admin-pass')?.value || '';
  const errorMsg = document.getElementById('login-error');

  if (useLocalStorage) {
    if (pass === "123456") { window.closeLoginModal(); switchView('admin'); }
    else { if (errorMsg) { errorMsg.innerText = "Modo Local: 123456"; errorMsg.classList.remove('hidden'); } }
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    window.closeLoginModal();
    switchView('admin');
  } catch (error) {
    if (errorMsg) { errorMsg.innerText = "Credenciales incorrectas"; errorMsg.classList.remove('hidden'); }
  }
};

window.logoutAdmin = async () => {
  if (!useLocalStorage) {
    await signOut(auth);
    await signInAnonymously(auth);
  }
  switchView('client');
};

async function loadSettings() {
  const backupPrompt = localStorage.getItem('lucia_brain_backup_v2');

  if (useLocalStorage) {
    currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
  } else {
    try {
      const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'));
      if (snap.exists()) currentSystemPrompt = snap.data().prompt || DEFAULT_PROMPT;
      else currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
    } catch (e) {
      currentSystemPrompt = backupPrompt || DEFAULT_PROMPT;
    }
  }

  const editor = document.getElementById('prompt-editor');
  if (editor) editor.value = currentSystemPrompt;
}

window.savePrompt = async () => {
  const val = document.getElementById('prompt-editor')?.value || '';
  currentSystemPrompt = val;

  localStorage.setItem('lucia_brain_backup_v2', val);

  if (useLocalStorage) {
    window.showToast("Guardado (Localmente)");
  } else {
    try {
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'config'),
        { prompt: val },
        { merge: true }
      );
      window.showToast("Prompt guardado correctamente");
    } catch (e) {
      console.error("Save error:", e);
      window.showToast("No se pudo guardar (Permisos/Conexión)");
    }
  }
};

window.switchView = (v) => {
  document.getElementById('admin-view')?.classList.toggle('view-hidden', v !== 'admin');
  document.getElementById('client-view')?.classList.toggle('view-hidden', v === 'admin');

  if (v === 'admin') {
    document.getElementById('admin-view')?.classList.add('flex');
    loadSettings(); // ✅ FIX: asegura editor actualizado
    loadLeads();
  } else if (v === 'client') {
    const dot = document.getElementById('db-status-dot');
    if (dot) {
      dot.classList.remove('bg-red-500');
      dot.classList.add('bg-green-500');
    }
  }
};

window.showAdminTab = (t) => {
  document.getElementById('section-leads')?.classList.toggle('hidden', t !== 'leads');
  document.getElementById('section-training')?.classList.toggle('hidden', t !== 'training');
  const navLeads = document.getElementById('nav-leads');
  const navTraining = document.getElementById('nav-training');
  if (navLeads) navLeads.className = t === 'leads' ? 'text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold' : 'text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors';
  if (navTraining) navTraining.className = t === 'training' ? 'text-white bg-white/10 px-4 py-2 rounded-lg text-sm font-bold' : 'text-slate-400 hover:text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors';
};

window.openDetailModal = async (id) => {
  const modal = document.getElementById('lead-detail-modal');
  modal?.classList.remove('hidden');
  modal?.classList.add('flex');

  let data = allLeadsCache.find(l => l.id === id);

  if (!data) {
    if (useLocalStorage) {
      data = JSON.parse(localStorage.getItem('sl_leads_data') || '{}')[id];
    } else {
      const s = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', id));
      if (s.exists()) data = s.data();
    }
  }

  if (data) {
    const summaryEl = document.getElementById('detail-summary');
    if (summaryEl) summaryEl.innerText = data.summary || "Esperando análisis...";

    if (data.history) {
      const historyEl = document.getElementById('detail-history');
      if (historyEl) {
        historyEl.innerHTML = Object.values(data.history)
          .sort((a, b) => a.ts - b.ts)
          .map(m => `<div class="mb-2"><span class="font-bold ${m.role === 'lucia' ? 'text-blue-600' : 'text-gray-800'}">${m.role === 'lucia' ? 'Lucía' : 'Cliente'}:</span> ${m.text}</div>`)
          .join('');
      }
    }

    const callBtn = document.getElementById('call-btn');
    const phoneEl = document.getElementById('detail-phone');
    const contactInfo = document.getElementById('contact-info');

    if (data.phone) {
      if (callBtn) {
        callBtn.innerHTML = `📞 Llamar a ${data.phone}`;
        callBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        callBtn.onclick = () => window.open(`tel:${data.phone}`);
      }
      if (phoneEl) phoneEl.innerText = data.phone;
      contactInfo?.classList.remove('hidden');
    } else {
      if (callBtn) {
        callBtn.innerHTML = "📞 Número No Disponible";
        callBtn.classList.add('opacity-50', 'cursor-not-allowed');
      }
      contactInfo?.classList.add('hidden');
    }
  }
};

window.closeDetailModal = () => {
  const modal = document.getElementById('lead-detail-modal');
  modal?.classList.add('hidden');
  modal?.classList.remove('flex');
};

window.toggleHistory = () => document.getElementById('detail-history')?.classList.toggle('hidden');

function renderLeadsTable() {
  const tbody = document.getElementById('leads-table-body');
  const emptyState = document.getElementById('empty-state');
  if (!tbody) return;

  tbody.innerHTML = '';

  const filtered = allLeadsCache.filter(l => l.status === '🔥 CALIENTE' || (l.summary && l.summary.length > 20));

  if (filtered.length === 0) emptyState?.classList.remove('hidden');
  else emptyState?.classList.add('hidden');

  const hotCount = allLeadsCache.filter(l => l.status === '🔥 CALIENTE').length;
  const badge = document.getElementById('badge-hot');
  if (badge) {
    if (hotCount > 0) { badge.innerText = String(hotCount); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  filtered.forEach(l => {
    const ts = l.updatedAt?.seconds ? (l.updatedAt.seconds * 1000) : (typeof l.updatedAt === 'number' ? l.updatedAt : Date.now());
    const d = new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    let name = l.summary?.split("Nombre:")[1]?.split("\n")[0] || "Prospecto";
    if (name.length > 25) name = "Prospecto";

    let interes = "General";
    if (l.summary && l.summary.toLowerCase().includes("funeral")) interes = "Funeral";
    else if (l.summary && l.summary.toLowerCase().includes("deuda")) interes = "Deudas";

    tbody.innerHTML += `
      <tr class="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td class="p-4 text-[11px] text-gray-400 font-mono">${d}</td>
        <td class="p-4 font-bold text-sm text-slate-700">${name}</td>
        <td class="p-4 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg w-fit px-2 py-1 inline-block">${interes}</td>
        <td class="p-4 text-right">
          <button onclick="openDetailModal('${l.id}')" class="text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm">Ver Ficha</button>
        </td>
      </tr>`;
  });
}

window.showToast = (msg) => {
  const toast = document.getElementById('toast');
  if (!toast) return;

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
};

window.manualRefresh = () => {
  loadLeads();
  window.showToast("Datos Actualizados");
};

function loadLeads() {
  if (useLocalStorage) {
    allLeadsCache = getLocalLeads();
    renderLeadsTable();
    return;
  }

  try {
    onSnapshot(
      collection(db, 'artifacts', appId, 'public', 'data', 'leads'),
      snap => {
        let data = [];
        snap.forEach(d => data.push({ id: d.id, ...d.data() }));
        allLeadsCache = data.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
        renderLeadsTable();
      },
      err => console.warn("Error cargando leads:", err)
    );
  } catch (e) {
    console.warn("Error snapshot", e);
  }
}

// ✅ FIX: incluye userId siempre para que Rules permita update/read por dueño
async function save(txt, role, status = null) {
  const data = {
    userId: currentUser?.uid,
    lastMessage: txt,
    [`history.${Date.now()}`]: { role, text: txt, ts: Date.now() },
    updatedAt: useLocalStorage ? Date.now() : serverTimestamp()
  };
  if (status) data.status = status;

  if (useLocalStorage) saveLocalLead(data);
  else if (currentUser) {
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), data);
    } catch (e) {
      console.warn("Error guardando msg", e);
      saveLocalLead(data);
    }
  }
}

async function analyzeLead() {
  const models = ["gemini-1.5-flash", "gemini-2.5-flash-preview-09-2025"];
  const prompt = `
ANALIZA el chat y extrae DATOS PUROS en formato JSON estricto:
{
  "name": "Nombre",
  "age": "Edad (solo número)",
  "state": "FL o TX",
  "phone": "Numero o null",
  "summary": "Resumen narrativo"
}
`;

  for (const m of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [...chatHistory, { role: "user", parts: [{ text: prompt }] }] })
      });
      if (!r.ok) continue;

      const d = await r.json();
      const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '').trim();
      if (!raw) continue;

      const json = JSON.parse(raw);

      const updateData = {
        summary: json.summary,
        extractedName: json.name,
        extractedAge: json.age,
        extractedState: json.state,
        phone: json.phone !== "null" ? json.phone : null
      };

      if (useLocalStorage) saveLocalLead(updateData);
      else await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', sessionId), updateData);

      break;
    } catch (e) {
      console.error("Error analizando:", e);
    }
  }
}

function appendMessageBubble(role, text, shouldSave = true) {
  const isClosing = text.includes("[CONECTAR_JORGE]");
  let cleanText = text.replace("[CONECTAR_JORGE]", "").replace(/\[CALIENTE\]/g, "");
  let buttons = null;

  if (role === 'lucia') {
    const regex = /\[BOTONES:\s*(.*?)\]/i;
    const match = cleanText.match(regex);
    if (match) {
      buttons = match[1].split(',').map(s => s.replace(/[\*\_\[\]]/g, '').trim());
      cleanText = cleanText.replace(regex, "").trim();
    }
  }

  const div = document.createElement('div');
  div.className = `bubble ${role} shadow-sm`;
  div.innerHTML = cleanText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

  document.getElementById('chat-box')?.appendChild(div);

  if (buttons) {
    const container = document.createElement('div');
    container.className = "quick-actions-container";
    buttons.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = "quick-btn";
      btn.innerText = opt;
      btn.onclick = () => { container.remove(); sendMessage(opt); };
      container.appendChild(btn);
    });
    document.getElementById('chat-box')?.appendChild(container);
  }

  div.scrollIntoView({ behavior: 'smooth' });

  if (isClosing) {
    const b = document.createElement('div');
    b.className = "ws-button";
    b.innerHTML = "<span>Conectar con Jorge por WhatsApp</span>";
    b.onclick = () => window.open(`https://wa.me/${JORGE_PHONE}?text=Hola, acabo de hablar con Lucía...`);
    document.getElementById('chat-box')?.appendChild(b);

    if (shouldSave) { save(cleanText, role, '🔥 CALIENTE').then(() => analyzeLead()); }
  } else if (shouldSave) {
    save(cleanText, role);
  }
}

async function sendMessage(manualText = null) {
  const input = document.getElementById('user-input');
  const text = manualText || (input?.value || '').trim();
  if (!text) return;

  appendMessageBubble('user', text);
  if (input) input.value = '';

  document.getElementById('loading')?.classList.remove('hidden');

  stepCount++;
  chatHistory.push({ role: "user", parts: [{ text }] });

  const models = ["gemini-1.5-flash", "gemini-2.5-flash-preview-09-2025"];
  let success = false;

  for (const m of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: chatHistory,
          systemInstruction: { parts: [{ text: currentSystemPrompt }] }
        })
      });

      if (!r.ok) continue;

      const d = await r.json();
      const t = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!t) continue;

      document.getElementById('loading')?.classList.add('hidden');
      appendMessageBubble('lucia', t);

      chatHistory.push({ role: "model", parts: [{ text: t }] });
      success = true;
      break;
    } catch (e) {}
  }

  if (!success) {
    document.getElementById('loading')?.classList.add('hidden');
    appendMessageBubble('lucia', "Hipo técnico. Inténtalo de nuevo.", false);
  }
}

// Exponer al HTML
window.sendMessage = sendMessage;

// Local storage helpers
function saveLocalLead(data) {
  const l = JSON.parse(localStorage.getItem('sl_leads_data') || '{}');
  l[sessionId] = { ...l[sessionId], ...data, id: sessionId, updatedAt: new Date().toISOString() };
  localStorage.setItem('sl_leads_data', JSON.stringify(l));
}

function getLocalLeads() {
  return Object.values(JSON.parse(localStorage.getItem('sl_leads_data') || '{}'))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

window.callProspect = () => {
  const phone = document.getElementById('detail-phone')?.innerText;
  if (phone && phone !== '--') window.open(`tel:${phone}`);
};
