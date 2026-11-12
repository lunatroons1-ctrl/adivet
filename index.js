// ============================================================
//  ADIVET — Webhook WhatsApp (Meta Cloud API + Claude + PostgreSQL)
//  Agente: Coco 🐾
// ============================================================

const express    = require("express");
const cors       = require("cors");
const { Pool }   = require("pg");
const Anthropic  = require("@anthropic-ai/sdk");

const app  = express();
app.use(cors());
app.use(express.json());

// ─── CLIENTES ────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── META CLOUD API CONFIG ─────────────────────────────────────
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;   // token del Usuario del Sistema (nunca expira)
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID; // ID del número de WhatsApp en Meta
const META_VERIFY_TOKEN  = process.env.META_VERIFY_TOKEN;
const META_API_VERSION   = "v21.0";
const CLINICA_ALERTA_NUMERO = process.env.CLINICA_ALERTA_NUMERO || ""; // a quién avisar (comprobantes y urgencias); formato 573001234567
// El dashboard solo muestra conversaciones desde esta fecha (hora de Colombia). Se puede cambiar con la variable CONVERSACIONES_DESDE en Railway.
const CONVERSACIONES_DESDE = process.env.CONVERSACIONES_DESDE || "2026-11-12T00:00:00-05:00";
const RECORDATORIO_DIAS = parseInt(process.env.RECORDATORIO_DIAS || "15", 10) || 15; // días tras una terapia para el recordatorio de control

// ─── GOOGLE CALENDAR (opcional: si no hay credenciales, simplemente no se usa) ───
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;                     // ID del calendario compartido de la clínica
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;   // JSON de la cuenta de servicio (o ese JSON en base64)
const ZONA_HORARIA = "America/Bogota";
const crypto = require("crypto");

// Fecha y hora actual en Colombia, para que Coco entienda "mañana", "el sábado", etc.
function fechaActualTexto() {
  const ahora = new Date();
  const fecha = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ahora);
  const hora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", hour12: false }).format(ahora);
  return `\n\nFECHA Y HORA ACTUAL EN COLOMBIA: ${fecha}, ${hora}.`;
}


// ─── BASE DE DATOS ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── SISTEMA PROMPT ───────────────────────────────────────────
const ANTICIPO_REGLA = "Por ahora ningún servicio requiere anticipo ni datos de pago: no los pidas y agenda directamente con el texto \"✅ CITA CONFIRMADA:\".";

const SYSTEM_PROMPT = `Eres "Coco", el asistente virtual de ADIVET Soluciones Veterinarias, clínica veterinaria en Kennedy (Bogotá). Lema: "Amor y pasión por tu mascota". Tu misión es atender con calidez, resolver dudas sobre los servicios y agendar citas.

SERVICIOS:
- Urgencias veterinarias 24 horas en Kennedy.
- Consulta veterinaria a domicilio (cobertura: Kennedy y zonas cercanas de Bogotá; si el barrio queda lejos, confirma con el equipo).
- Láser terapia y fisioterapia.
- Hospitalización en casa.
Línea del equipo humano y de urgencias: 314 323 0175.

PRECIOS: todavía no hay una lista de precios cargada. Nunca inventes valores: si preguntan, responde "te confirmo ese valor con nuestro equipo" y ofrece el 314 323 0175.

REGLAS DE COMPORTAMIENTO:
1. Saluda con calidez y pregunta el nombre de la mascota al inicio.
2. Cuando pregunten por un servicio, explica en 2-3 frases cómo funciona y SIEMPRE termina con una pregunta de cierre.
3. DATOS DEL CLIENTE (en TODA conversación): pide con naturalidad, de a poco y sin sonar a interrogatorio, el nombre del dueño, el nombre de la mascota, la especie y la raza. Para consulta a domicilio y hospitalización en casa pide además la dirección y el barrio. Para agendar pide el día y la hora preferidos y confirma con un resumen.
4. URGENCIAS: si mencionan atropello, intoxicación o veneno, convulsiones, dificultad para respirar, sangrado abundante, trauma, vómito o diarrea con sangre, imposibilidad de orinar, parto difícil, golpe de calor, o dicen que es urgente: responde con calma y en pocas líneas, pide que llamen YA al 314 323 0175, pregunta el barrio o la ubicación, NO des tratamientos ni medicamentos, y agrega AL FINAL, en una línea aparte, este formato exacto: [[URGENCIA|motivo en pocas palabras]]. Esa línea es interna: el cliente no la ve, nunca la menciones. Las urgencias NO se agendan en el calendario.
5. ANTICIPO: ${ANTICIPO_REGLA}
6. Si el cliente dice "caro" o "lo pienso", valida su sentimiento y reenfoca en el bienestar de su mascota.
7. Usa emojis con moderación (🐾 🐶 🐱 🩺 📅).
8. Nunca inventes precios, horarios, coberturas ni servicios fuera de esta lista. Si algo no está, di "te confirmo eso con nuestro equipo".
9. Responde SIEMPRE en español, de forma cercana, breve y directa. Máximo 4 oraciones por respuesta.
10. ASESORÍA CON HUMANO: no diagnostiques, no recetes y no des dosis. Si la pregunta va más allá de servicios, horarios o agendar (síntomas específicos, dudas médicas, quejas, resultados, facturas), ofrece hablar con el equipo humano al 314 323 0175. Ejemplo: "Para eso te recomiendo hablar directo con nuestro equipo al 314 323 0175, ellos te van a asesorar mejor 🐾".
11. Si ya tienes los datos para agendar, muestra un resumen con el texto "✅ CITA CONFIRMADA:" al inicio, con estas líneas separadas: Dueño, Mascota, Servicio, Dirección (solo en domicilio y hospitalización en casa), Fecha y hora.
12. IMPORTANTE: cuando guardes una cita, menciona el servicio para que quede registrado.
13. PRODUCTOS: no hay catálogo cargado. Si preguntan por medicamentos o productos, di que el equipo lo confirma; los medicamentos requieren valoración veterinaria previa.
14. DATOS INTERNOS DEL CLIENTE: cada vez que conozcas datos del cliente (nombre del dueño, nombre de la mascota, especie o raza), agrega AL FINAL de tu respuesta, en una línea aparte y sin nada después, este formato exacto: [[DATOS|dueno=NOMBRE|mascota=NOMBRE|especie=perro o gato|raza=RAZA]]. Incluye solo los campos que ya conozcas. Esta línea es interna: el cliente no la ve, así que nunca la menciones ni la expliques.
15. FECHA Y HORA DE LAS CITAS: al final de estas instrucciones se indica la fecha y hora actual en Colombia y la agenda real. Ofrece solo horarios de esa agenda; si no hay cupos, di que el equipo confirmará un horario. Si el cliente no ha dado una hora exacta, pídela antes de confirmar. En el resumen de la cita es OBLIGATORIO incluir, además de "Fecha y hora", una línea con este formato exacto, en hora de Colombia y reloj de 24 horas: Inicio: AAAA-MM-DD HH:MM (por ejemplo: Inicio: 2026-11-14 10:00). Sin esa línea la cita NO queda en el calendario del equipo.`;

// ─── HELPERS BD ───────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id         SERIAL PRIMARY KEY,
      telefono   TEXT NOT NULL,
      rol        TEXT NOT NULL,
      contenido  TEXT NOT NULL,
      creado_en  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id              SERIAL PRIMARY KEY,
      telefono        TEXT UNIQUE NOT NULL,
      nombre_dueno    TEXT,
      nombre_mascota  TEXT,
      especie         TEXT,
      raza            TEXT,
      creado_en       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS citas (
      id                SERIAL PRIMARY KEY,
      telefono          TEXT NOT NULL,
      nombre_dueno      TEXT,
      nombre_mascota    TEXT,
      servicio          TEXT,
      horario_preferido TEXT,
      estado            TEXT DEFAULT 'pendiente',
      tipo              TEXT DEFAULT 'normal',
      creado_en         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cotizaciones (
      id          SERIAL PRIMARY KEY,
      telefono    TEXT NOT NULL,
      servicio    TEXT,
      precio      TEXT,
      tipo        TEXT DEFAULT 'normal',
      creado_en   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pagos (
      id          SERIAL PRIMARY KEY,
      telefono    TEXT NOT NULL,
      cita_id     INTEGER REFERENCES citas(id),
      media_id    TEXT,
      monto       TEXT DEFAULT 'Anticipo',
      estado      TEXT DEFAULT 'pendiente',
      creado_en   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS banos (
      id               SERIAL PRIMARY KEY,
      telefono         TEXT NOT NULL,
      nombre_mascota   TEXT,
      ultimo_bano      TIMESTAMPTZ DEFAULT NOW(),
      recordatorio_enviado BOOLEAN DEFAULT false,
      creado_en        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE citas ADD COLUMN IF NOT EXISTS inicio_local TEXT;
    ALTER TABLE citas ADD COLUMN IF NOT EXISTS google_event_id TEXT;
    ALTER TABLE citas ADD COLUMN IF NOT EXISTS direccion TEXT;
  `);
  console.log("✅ Tablas listas en PostgreSQL");
}

// La API de Claude falla si el historial empieza con un mensaje del asistente, tiene mensajes vacíos
// o roles repetidos. Esto lo deja siempre en un formato válido.
function normalizarHistorial(mensajes) {
  const limpio = [];
  for (const m of mensajes) {
    const contenido = String(m.content || "").trim();
    if (!contenido) continue;
    const ultimo = limpio[limpio.length - 1];
    if (ultimo && ultimo.role === m.role) {
      ultimo.content += "\n" + contenido;
    } else {
      limpio.push({ role: m.role, content: contenido });
    }
  }
  while (limpio.length && limpio[0].role !== "user") limpio.shift();
  return limpio;
}

async function getHistorial(telefono) {
  const { rows } = await pool.query(
    `SELECT rol, contenido FROM conversaciones
     WHERE telefono = $1
     ORDER BY creado_en DESC
     LIMIT 20`,
    [telefono]
  );
  return rows.reverse().map(r => ({ role: r.rol, content: r.contenido }));
}

async function guardarMensaje(telefono, rol, contenido) {
  await pool.query(
    `INSERT INTO conversaciones (telefono, rol, contenido) VALUES ($1, $2, $3)`,
    [telefono, rol, contenido]
  );
}

async function upsertCliente(telefono, datos = {}) {
  await pool.query(
    `INSERT INTO clientes (telefono, nombre_dueno, nombre_mascota, especie, raza)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telefono) DO UPDATE SET
       nombre_dueno   = COALESCE(EXCLUDED.nombre_dueno,   clientes.nombre_dueno),
       nombre_mascota = COALESCE(EXCLUDED.nombre_mascota, clientes.nombre_mascota),
       especie        = COALESCE(EXCLUDED.especie,        clientes.especie),
       raza           = COALESCE(EXCLUDED.raza,           clientes.raza)`,
    [telefono, datos.nombre_dueno || null, datos.nombre_mascota || null,
               datos.especie || null, datos.raza || null]
  );
}

// Saca de la respuesta de Coco la línea interna [[DATOS|...]] y devuelve el texto limpio + los datos
function extraerDatosCliente(textoOriginal) {
  const re = /\[\[DATOS\|([^\]]*)\]\]/g;
  const mapa = { dueno: "nombre_dueno", mascota: "nombre_mascota", especie: "especie", raza: "raza" };
  let datos = null;
  let m;
  while ((m = re.exec(textoOriginal)) !== null) {
    datos = datos || {};
    for (const par of m[1].split("|")) {
      const idx = par.indexOf("=");
      if (idx === -1) continue;
      const clave = mapa[par.slice(0, idx).trim().toLowerCase()];
      const valor = par.slice(idx + 1).trim().slice(0, 80);
      if (clave && valor) datos[clave] = valor;
    }
  }
  const texto = textoOriginal.replace(re, "").trim();
  return { texto, datos: datos && Object.keys(datos).length ? datos : null };
}

// Registra o reinicia el contador de 20 días para el recordatorio de baño
async function registrarBano(telefono, mascota) {
  const { rows } = await pool.query(
    `SELECT id FROM banos WHERE telefono = $1 ORDER BY creado_en DESC LIMIT 1`,
    [telefono]
  );
  if (rows.length > 0) {
    await pool.query(
      `UPDATE banos SET ultimo_bano = NOW(), recordatorio_enviado = false, nombre_mascota = COALESCE($2, nombre_mascota) WHERE id = $1`,
      [rows[0].id, mascota || null]
    );
  } else {
    await pool.query(
      `INSERT INTO banos (telefono, nombre_mascota, ultimo_bano, recordatorio_enviado) VALUES ($1, $2, NOW(), false)`,
      [telefono, mascota || null]
    );
  }
}

// ─── GOOGLE CALENDAR ──────────────────────────────────────────
let credencialesGoogle = null;
let tokenGoogle = { valor: null, expira: 0 };

function leerCredencialesGoogle() {
  if (credencialesGoogle) return credencialesGoogle;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_CALENDAR_ID) return null;
  try {
    let texto = GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    if (!texto.startsWith("{")) texto = Buffer.from(texto, "base64").toString("utf8"); // también acepta el JSON en base64
    const json = JSON.parse(texto);
    if (!json.client_email || !json.private_key) throw new Error("faltan client_email o private_key");
    json.private_key = json.private_key.replace(/\\n/g, "\n");
    credencialesGoogle = json;
    return json;
  } catch (err) {
    console.error("❌ Credenciales de Google Calendar inválidas:", err.message);
    return null;
  }
}

const base64url = (datos) =>
  Buffer.from(datos).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function obtenerTokenGoogle() {
  const cred = leerCredencialesGoogle();
  if (!cred) return null;
  if (tokenGoogle.valor && Date.now() < tokenGoogle.expira - 60000) return tokenGoogle.valor;

  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: cred.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  }));
  const firma = crypto.createSign("RSA-SHA256").update(`${cabecera}.${claims}`).sign(cred.private_key);
  const jwt = `${cabecera}.${claims}.${base64url(firma)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google rechazó las credenciales: ${await res.text()}`);
  const datos = await res.json();
  tokenGoogle = { valor: datos.access_token, expira: Date.now() + (datos.expires_in || 3600) * 1000 };
  return tokenGoogle.valor;
}

// Quita el precio del nombre del servicio: "Baño medicado (desde $70.000)" -> "Baño medicado"
function nombreServicio(servicio) {
  const limpio = String(servicio || "")
    .replace(/\s*(?:[(\-–—:]\s*)?(?:desde\s*)?\$\s*[\d.,]+(?:\s*[-–]\s*\$?\s*[\d.,]+)?\s*(?:COP)?\s*\)?\s*$/i, "")
    .trim();
  return limpio || String(servicio || "").trim();
}

function duracionMinutos(servicio) {
  const s = String(servicio || "");
  return 60; // domicilio, terapias y visitas de hospitalización en casa
}

// "2026-11-14" + "10:00" (hora de Colombia) -> { inicio, fin } sin zona; la zona se manda aparte
function rangoEvento(fecha, hora, minutos) {
  const [y, m, d] = fecha.split("-").map(Number);
  const [h, mi] = hora.split(":").map(Number);
  const fin = new Date(Date.UTC(y, m - 1, d, h, mi + minutos));
  const dos = (n) => String(n).padStart(2, "0");
  const finTexto = `${fin.getUTCFullYear()}-${dos(fin.getUTCMonth() + 1)}-${dos(fin.getUTCDate())}T${dos(fin.getUTCHours())}:${dos(fin.getUTCMinutes())}:00`;
  return { inicio: `${fecha}T${hora}:00`, fin: finTexto };
}

// ─── DISPONIBILIDAD según la agenda real de la clínica ───
// El calendario de la clínica funciona con CUPOS: eventos llamados "Cupo Domicilio N" y "Cupo Terapia N".
// Cuando se agenda una cita, el cupo se renombra con el nombre de la mascota. Un cupo libre = un evento que todavía conserva ese nombre.
const SLOT_CONSULTA   = /^\s*cupo\s+domicilio/i;
const SLOT_PELUQUERIA = /^\s*cupo\s+terapia/i;
const SERVICIO_CIRUGIA = /hospitaliz/i;
const CITAS_SIMULTANEAS = parseInt(process.env.CITAS_SIMULTANEAS || "1", 10) || 1; // cirugías que pueden coincidir en la misma hora
let cacheAgenda = { valor: null, expira: 0 };

function tipoServicio(servicio) {
  const s = String(servicio || "");
  if (/l[aá]ser|fisio|terapia/i.test(s)) return "peluqueria"; // cupos de terapia
  if (SERVICIO_CIRUGIA.test(s)) return "cirugia";
  return "consulta"; // consulta, vacunas, controles, etc.
}

// Lee del calendario los eventos con hora que se cruzan con el rango (ignora cancelados, "disponible" y de todo el día)
async function listarEventosCalendario(desde, hasta) {
  const token = await obtenerTokenGoogle();
  if (!token) return null; // Calendar no está configurado
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?` +
    new URLSearchParams({
      timeMin: desde.toISOString(),
      timeMax: hasta.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
    });
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`no se pudo leer el calendario: ${await r.text()}`);
  const datos = await r.json();
  return (datos.items || [])
    .filter(e => e.status !== "cancelled" && e.transparency !== "transparent" && e.start?.dateTime && e.end?.dateTime)
    .map(e => ({ id: e.id, titulo: e.summary || "", inicio: new Date(e.start.dateTime), fin: new Date(e.end.dateTime) }));
}

// Cupos que siguen libres (conservan su nombre original) para un tipo de servicio, desde cierta fecha
function cuposLibres(eventos, tipo, desde) {
  const patron = tipo === "peluqueria" ? SLOT_PELUQUERIA : SLOT_CONSULTA;
  return eventos.filter(e => patron.test(e.titulo) && e.inicio.getTime() > desde.getTime());
}

// El cupo libre que empieza exactamente a esa hora (si hay varios, el primero por nombre)
function cupoLibreA(eventos, tipo, inicio) {
  return cuposLibres(eventos, tipo, new Date(0))
    .filter(e => Math.abs(e.inicio.getTime() - inicio.getTime()) < 60000)
    .sort((a, b) => a.titulo.localeCompare(b.titulo, "es", { numeric: true }))[0] || null;
}

// Devuelve los bloques [inicio, fin] donde ya se alcanzó el máximo de citas simultáneas
function bloquesOcupados(eventos, capacidad) {
  const puntos = [];
  for (const e of eventos) puntos.push([e.inicio.getTime(), 1], [e.fin.getTime(), -1]);
  puntos.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // si un evento termina cuando otro empieza, no se cruzan
  const bloques = [];
  let activos = 0;
  let inicioBloque = null;
  for (const [t, delta] of puntos) {
    const antes = activos;
    activos += delta;
    if (antes < capacidad && activos >= capacidad) inicioBloque = t;
    if (antes >= capacidad && activos < capacidad && inicioBloque !== null) {
      bloques.push([inicioBloque, t]);
      inicioBloque = null;
    }
  }
  return bloques;
}

function eventosQuirurgicos(eventos) {
  return eventos.filter(e => !SLOT_CONSULTA.test(e.titulo) && !SLOT_PELUQUERIA.test(e.titulo) && SERVICIO_CIRUGIA.test(e.titulo));
}

// Texto que se le agrega a Coco con la disponibilidad real de los próximos 14 días
async function agendaOcupadaTexto() {
  try {
    if (!leerCredencialesGoogle()) return "";
    if (cacheAgenda.valor !== null && Date.now() < cacheAgenda.expira) return cacheAgenda.valor;

    const ahora = new Date();
    const margen = new Date(ahora.getTime() + 30 * 60000); // no se ofrecen cupos que empiezan en menos de 30 minutos
    const eventos = await listarEventosCalendario(ahora, new Date(ahora.getTime() + 14 * 24 * 3600 * 1000));
    if (!eventos) return "";

    const fDia  = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, weekday: "long", day: "numeric", month: "long" });
    const fHora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", hour12: false });
    const listaPorDia = (items, formatear) => {
      const porDia = new Map();
      for (const e of items) {
        const dia = fDia.format(e.inicio);
        const horas = porDia.get(dia) || new Map();
        const k = formatear(e);
        horas.set(k, (horas.get(k) || 0) + 1);
        porDia.set(dia, horas);
      }
      const lineas = [...porDia].map(([dia, horas]) =>
        `- ${dia}: ` + [...horas].map(([k, n]) => (n > 1 ? `${k} (${n} cupos)` : k)).join(", "));
      return lineas.length ? lineas.join("\n") : "- No hay cupos libres.";
    };

    const consulta = cuposLibres(eventos, "consulta", margen);
    const pelu = cuposLibres(eventos, "peluqueria", margen);
    const bloques = bloquesOcupados(eventosQuirurgicos(eventos), CITAS_SIMULTANEAS)
      .filter(([, fin]) => fin > ahora.getTime())
      .map(([i, f]) => ({ inicio: new Date(i), fin: new Date(f) }));

    const texto =
      `\n\nAGENDA REAL DE LA CLÍNICA (próximos 14 días, hora de Colombia, reloj de 24 horas).\n` +
      `CUPOS LIBRES para CONSULTA A DOMICILIO (cada cupo dura 1 hora):\n${listaPorDia(consulta, e => fHora.format(e.inicio))}\n` +
      `CUPOS LIBRES para LÁSER TERAPIA y FISIOTERAPIA:\n${listaPorDia(pelu, e => `${fHora.format(e.inicio)} (hasta ${fHora.format(e.fin)})`)}\n` +
      `HORARIOS YA OCUPADOS para HOSPITALIZACIÓN EN CASA:\n` +
      `${bloques.length ? listaPorDia(bloques, e => `${fHora.format(e.inicio)} a ${fHora.format(e.fin)}`) : "- No hay horarios ocupados."}\n` +
      `Reglas: para consultas a domicilio, láser terapia y fisioterapia ofrece y confirma SOLO la hora de inicio de un cupo libre de la lista; si el cliente pide otra hora, ofrécele el cupo libre más cercano. ` +
      `Un día sin cupos libres está lleno. Para hospitalización en casa ofrece cualquier hora que no se cruce con los bloques ocupados (cada visita dura 1 hora). ` +
      `No menciones que consultas un calendario.`;

    cacheAgenda = { valor: texto, expira: Date.now() + 60 * 1000 }; // se reutiliza 1 minuto
    return texto;
  } catch (err) {
    console.error("⚠️ No se pudo leer la agenda de Google Calendar:", err.message);
    return "";
  }
}

// Última verificación antes de confirmar: ¿el horario que Coco acaba de confirmar sigue libre?
async function hayConflictoCalendario(telefono, respuesta) {
  try {
    if (!leerCredencialesGoogle()) return false;
    const m = respuesta.match(/Inicio[:\*\s]+(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2}):(\d{2})/i);
    if (!m) return false;
    const servicio = (respuesta.match(/Servicio[:\*\s]+([^\n\*•]+)/i) || [])[1] || "";
    const ini = new Date(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00-05:00`);
    if (isNaN(ini.getTime())) return false;
    const tipo = tipoServicio(servicio);

    // Consultas, vacunas, baños y peluquería: debe seguir libre un cupo que empiece a esa hora
    if (tipo !== "cirugia") {
      const cercanos = await listarEventosCalendario(new Date(ini.getTime() - 60000), new Date(ini.getTime() + 60000));
      if (!cercanos) return false;
      return !cupoLibreA(cercanos, tipo, ini);
    }

    // Cirugías: no pueden cruzarse con otras cirugías
    const fin = new Date(ini.getTime() + duracionMinutos(servicio) * 60000);
    const propio = await pool.query(
      `SELECT google_event_id FROM citas WHERE telefono = $1 AND estado = 'pendiente_pago' AND google_event_id IS NOT NULL ORDER BY creado_en DESC LIMIT 1`,
      [telefono]
    );
    const idPropio = propio.rows[0]?.google_event_id; // la cita pendiente de este mismo cliente no cuenta contra sí misma
    const eventos = await listarEventosCalendario(ini, fin);
    if (!eventos) return false;
    const cruzados = eventosQuirurgicos(eventos).filter(e => e.id !== idPropio && e.inicio < fin && e.fin > ini);
    return cruzados.length >= CITAS_SIMULTANEAS;
  } catch (err) {
    console.error("⚠️ No se pudo verificar la disponibilidad:", err.message);
    return false; // si falla la consulta, Coco sigue atendiendo normal
  }
}

// Crea o actualiza en Google Calendar el evento de una cita. Nunca lanza errores: si algo falla, solo lo registra.
// Consultas, vacunas, baños y peluquería: toma el cupo libre de esa hora y lo renombra con los datos de la cita.
// Cirugías: crea un evento nuevo.
async function sincronizarCalendario(citaId) {
  try {
    if (!citaId) return;
    const token = await obtenerTokenGoogle();
    if (!token) return; // Calendar no está configurado

    const { rows } = await pool.query(`SELECT * FROM citas WHERE id = $1`, [citaId]);
    const c = rows[0];
    if (!c) return;
    if (!c.inicio_local) {
      console.log(`📅 Cita #${citaId} sin fecha y hora exactas: no se agrega al calendario`);
      return;
    }

    const [fecha, hora] = c.inicio_local.split(" ");
    const tipo = tipoServicio(c.servicio);
    const { inicio, fin } = rangoEvento(fecha, hora, duracionMinutos(c.servicio));
    const horario = {
      start: { dateTime: inicio, timeZone: ZONA_HORARIA },
      end:   { dateTime: fin,    timeZone: ZONA_HORARIA },
    };
    const estadoTxt = c.estado === "confirmada" ? "✅" : "⏳ Pendiente de pago";
    const servicioLimpio = nombreServicio(c.servicio);
    const resumen = `${estadoTxt} ${c.nombre_mascota || "Mascota"} — ${servicioLimpio || "Cita"}${c.nombre_dueno ? ` (${c.nombre_dueno})` : ""}`;
    const datosCita = {
      summary: resumen,
      description: [
        `Dueño: ${c.nombre_dueno || "—"}`,
        `Mascota: ${c.nombre_mascota || "—"}`,
        `Servicio: ${servicioLimpio || "—"}`,
        `Teléfono: +${c.telefono}`,
        `Dirección: ${c.direccion || "—"}`,
        `Estado: ${c.estado}`,
        "",
        "Agendada por Coco (WhatsApp)",
      ].join("\n"),
    };

    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const guardarEvento = async (id) => {
      await pool.query(`UPDATE citas SET google_event_id = $2 WHERE id = $1`, [citaId, id]);
      cacheAgenda = { valor: null, expira: 0 };
    };

    // 1) La cita ya tiene evento: solo se actualizan título y descripción (en cirugías también el horario)
    if (c.google_event_id) {
      const cuerpo = tipo === "cirugia" ? { ...datosCita, ...horario } : datosCita;
      const r = await fetch(`${base}/${c.google_event_id}`, { method: "PATCH", headers, body: JSON.stringify(cuerpo) });
      if (r.ok) {
        console.log(`📅 Evento actualizado en Google Calendar (cita #${citaId})`);
        cacheAgenda = { valor: null, expira: 0 };
        return;
      }
      // Si el evento fue borrado en el calendario, se vuelve a crear
      if (r.status !== 404 && r.status !== 410) throw new Error(`no se pudo actualizar el evento: ${await r.text()}`);
    }

    // 2) Consulta, vacuna, baño o peluquería: se toma el cupo libre que empieza a esa hora
    let titulo = datosCita.summary;
    if (tipo !== "cirugia") {
      const ini = new Date(`${fecha}T${hora}:00-05:00`);
      const cercanos = await listarEventosCalendario(new Date(ini.getTime() - 60000), new Date(ini.getTime() + 60000));
      const cupo = cupoLibreA(cercanos || [], tipo, ini);
      if (cupo) {
        const r = await fetch(`${base}/${cupo.id}`, { method: "PATCH", headers, body: JSON.stringify(datosCita) });
        if (!r.ok) throw new Error(`no se pudo tomar el cupo: ${await r.text()}`);
        await guardarEvento(cupo.id);
        console.log(`📅 Cupo "${cupo.titulo}" tomado en Google Calendar (cita #${citaId})`);
        return;
      }
      console.log(`⚠️ No había un cupo libre a las ${hora} del ${fecha}: se crea un evento aparte`);
      titulo = `⚠️ SIN CUPO · ${datosCita.summary}`;
    }

    // 3) Cirugías (o si no había cupo): evento nuevo
    const r = await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...datosCita, summary: titulo, ...horario }) });
    if (!r.ok) throw new Error(`no se pudo crear el evento: ${await r.text()}`);
    const creado = await r.json();
    await guardarEvento(creado.id);
    console.log(`📅 Evento creado en Google Calendar (cita #${citaId})`);
  } catch (err) {
    console.error("⚠️ Google Calendar:", err.message);
  }
}

// Respaldo: si Coco olvidó la línea "Inicio:", se le pide a Claude que convierta el texto de "Fecha y hora"
async function inferirInicio(textoFechaHora) {
  try {
    if (!leerCredencialesGoogle() || !textoFechaHora) return null;
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 60,
      messages: [{
        role: "user",
        content: `${fechaActualTexto().trim()}\nConvierte esta fecha y hora al formato AAAA-MM-DD HH:MM (reloj de 24 horas, hora de Colombia). Responde SOLO con ese formato, o con la palabra NULO si no hay una hora exacta.\nTexto: ${textoFechaHora}`,
      }],
    });
    const t = r.content.map(b => b.text || "").join("").trim();
    const m = t.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
    return m ? `${m[1]} ${m[2].padStart(2, "0")}:${m[3]}` : null;
  } catch (err) {
    console.error("⚠️ No se pudo deducir la hora de la cita:", err.message);
    return null;
  }
}

// Completa nombre del dueño y de la mascota en la tabla clientes a partir de la cita
async function completarCliente(telefono, dueno, mascota) {
  const nombreMascota = mascota ? mascota.split("(")[0].trim().slice(0, 80) : null;
  if (!dueno && !nombreMascota) return;
  await upsertCliente(telefono, { nombre_dueno: dueno || null, nombre_mascota: nombreMascota || null });
}

async function guardarCita(telefono, respuesta, estado = "confirmada") {
  const fueraHorario = /fuera de horario/i.test(respuesta);
  const dueno    = (respuesta.match(/Dueño[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
  const mascota  = (respuesta.match(/Mascota[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
  const servicio = (respuesta.match(/Servicio[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
  const horario  = (respuesta.match(/(?:Fecha y hora|Fecha|Horario)[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
  const direccion = (respuesta.match(/Direcci[oó]n[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
  const tipo     = fueraHorario ? "fuera_horario" : "normal";
  const mInicio  = respuesta.match(/Inicio[:\*\s]+(\d{4}-\d{2}-\d{2})[ T]+(\d{1,2}):(\d{2})/i);
  let inicioLocal = mInicio ? `${mInicio[1]} ${mInicio[2].padStart(2, "0")}:${mInicio[3]}` : null;
  if (!inicioLocal) {
    inicioLocal = await inferirInicio(horario);
    console.log(inicioLocal
      ? `📅 Coco no escribió la línea "Inicio:"; se dedujo ${inicioLocal} de "${horario}"`
      : `📅 La cita no trae una hora exacta (Fecha y hora: "${horario}"): no se agregará al calendario`);
  }

  // Si ya hay una cita pendiente de pago de este cliente, la actualiza en vez de duplicarla
  if (estado === "pendiente_pago") {
    const existente = await pool.query(
      `SELECT id FROM citas WHERE telefono = $1 AND estado = 'pendiente_pago' ORDER BY creado_en DESC LIMIT 1`,
      [telefono]
    );
    if (existente.rows.length > 0) {
      const id = existente.rows[0].id;
      await pool.query(
        `UPDATE citas SET
           nombre_dueno      = COALESCE($2, nombre_dueno),
           nombre_mascota    = COALESCE($3, nombre_mascota),
           servicio          = COALESCE($4, servicio),
           horario_preferido = COALESCE($5, horario_preferido),
           tipo              = $6,
           inicio_local      = COALESCE($7, inicio_local),
           direccion         = COALESCE($8, direccion)
         WHERE id = $1`,
        [id, dueno, mascota, servicio, horario, tipo, inicioLocal, direccion]
      );
      await completarCliente(telefono, dueno, mascota);
      sincronizarCalendario(id); // sin await: no retrasa la respuesta al cliente
      return id;
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO citas (telefono, nombre_dueno, nombre_mascota, servicio, horario_preferido, estado, tipo, inicio_local, direccion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [telefono, dueno, mascota, servicio, horario, estado, tipo, inicioLocal, direccion]
  );
  await completarCliente(telefono, dueno, mascota);
  const nuevoId = rows[0]?.id || null;
  sincronizarCalendario(nuevoId); // sin await: no retrasa la respuesta al cliente
  return nuevoId;
}

// Busca la cita más reciente de un cliente que todavía no tiene pago verificado
async function obtenerCitaPendiente(telefono) {
  const { rows } = await pool.query(
    `SELECT id FROM citas WHERE telefono = $1 AND estado = 'pendiente_pago'
     ORDER BY creado_en DESC LIMIT 1`,
    [telefono]
  );
  return rows[0]?.id || null;
}

async function detectarYGuardarCotizacion(telefono, respuesta) {
  if (!/\$\s*\d/.test(respuesta)) return; // solo registra cuando la respuesta trae un precio
  const PRECIOS = [
    { patron: /domicilio/i,        servicio: "Consulta a domicilio",    precio: "según caso" },
    { patron: /l[aá]ser/i,         servicio: "Láser terapia",           precio: "según caso" },
    { patron: /fisioterapia/i,     servicio: "Fisioterapia",            precio: "según caso" },
    { patron: /hospitalizaci[oó]n/i, servicio: "Hospitalización en casa", precio: "según caso" },
  ];
  for (const { patron, servicio, precio } of PRECIOS) {
    if (patron.test(respuesta)) {
      const fueraHorario = /fuera de horario/i.test(respuesta);
      await pool.query(
        `INSERT INTO cotizaciones (telefono, servicio, precio, tipo) VALUES ($1, $2, $3, $4)`,
        [telefono, servicio, precio, fueraHorario ? "fuera_horario" : "normal"]
      );
      break;
    }
  }
}

// ─── ENVÍO DE MENSAJES VÍA META CLOUD API ──────────────────────
async function enviarWhatsApp(telefono, texto) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      // Con número de teléfono se usa "to"; con ID de usuario (cliente que oculta su número) se usa "recipient"
      [/^\d+$/.test(String(telefono)) ? "to" : "recipient"]: telefono,
      type: "text",
      text: { body: texto },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`❌ Error enviando mensaje a ${telefono}:`, errBody);
  }
}

// Reenvía una imagen (por media_id) a un número de WhatsApp, con texto opcional
async function reenviarImagen(telefono, mediaId, caption) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono,
      type: "image",
      image: { id: mediaId, caption: caption || "" },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`❌ Error reenviando imagen a ${telefono}:`, errBody);
  }
}

// Descarga la imagen de Meta y le pregunta a Claude si es un comprobante de pago.
// Devuelve { es_comprobante, monto } o null si no se pudo analizar (en ese caso se asume que sí lo es).
async function analizarComprobante(mediaId) {
  try {
    const headers = { Authorization: `Bearer ${META_ACCESS_TOKEN}` };
    const meta = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${mediaId}`, { headers });
    if (!meta.ok) return null;
    const { url, mime_type } = await meta.json();

    const img = await fetch(url, { headers });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 4.5 * 1024 * 1024) return null;

    const tipo = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime_type) ? mime_type : "image/jpeg";
    const r = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: tipo, data: buf.toString("base64") } },
          { type: "text", text: 'Responde SOLO con un JSON, sin texto extra: {"es_comprobante": true o false, "monto": "valor pagado como aparece en la imagen, o null"}. es_comprobante es true únicamente si la imagen es un comprobante, recibo o pantallazo de un pago o transferencia (Nequi, Daviplata, banco u otro). Una foto de una mascota, un documento, un examen u otra cosa es false.' },
        ],
      }],
    });
    const texto = r.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    const json = JSON.parse(texto);
    return { es_comprobante: json.es_comprobante !== false, monto: json.monto || null };
  } catch (err) {
    console.error("⚠️ No se pudo analizar la imagen:", err.message);
    return null;
  }
}

// Guarda el comprobante recibido y avisa a la clínica
async function procesarComprobante(telefono, mediaId, citaId, montoDetectado) {
  const { rows } = await pool.query(
    `INSERT INTO pagos (telefono, cita_id, media_id, monto, estado)
     VALUES ($1, $2, $3, COALESCE($4, 'Anticipo'), 'pendiente') RETURNING id`,
    [telefono, citaId, mediaId, montoDetectado || null]
  );
  const pagoId = rows[0].id;

  const lineaMonto = montoDetectado ? `\nMonto que se lee en la imagen: ${montoDetectado}` : "";
  const aviso = `💰 Nuevo comprobante de pago recibido.\nCliente: ${telefono}\nCita #${citaId}\nPago #${pagoId}${lineaMonto}\n\nVerifícalo en el dashboard para confirmar la cita.`;

  if (CLINICA_ALERTA_NUMERO) {
    await reenviarImagen(CLINICA_ALERTA_NUMERO, mediaId, aviso);
    await enviarWhatsApp(CLINICA_ALERTA_NUMERO, aviso);
  }

  return citaId;
}

// Urgencia detectada por Coco: queda en el panel (pestaña Urgencias) y se avisa a la clínica por WhatsApp
async function registrarUrgencia(telefono, motivo) {
  const reciente = await pool.query(`SELECT 1 FROM citas WHERE telefono = $1 AND tipo = 'urgencia' AND creado_en > NOW() - INTERVAL '30 minutes'`, [telefono]);
  if (reciente.rows.length) return;
  const { rows } = await pool.query(`SELECT nombre_dueno, nombre_mascota FROM clientes WHERE telefono = $1`, [telefono]);
  const c = rows[0] || {};
  const m = String(motivo || "").slice(0, 120);
  await pool.query(
    `INSERT INTO citas (telefono, nombre_dueno, nombre_mascota, servicio, horario_preferido, estado, tipo)
     VALUES ($1, $2, $3, $4, 'Ahora', 'pendiente', 'urgencia')`,
    [telefono, c.nombre_dueno || null, c.nombre_mascota || null, `Urgencia: ${m}`]
  );
  if (CLINICA_ALERTA_NUMERO) {
    await enviarWhatsApp(CLINICA_ALERTA_NUMERO, `🚨 URGENCIA por WhatsApp\nCliente: ${telefono}\n${c.nombre_mascota ? "Mascota: " + c.nombre_mascota + "\n" : ""}Motivo: ${m}\nComunícate de inmediato.`);
  }
}

// ─── VERIFICACIÓN DEL WEBHOOK (Meta la llama por GET) ──────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ Falló verificación del webhook");
  res.sendStatus(403);
});

// ─── WEBHOOK PRINCIPAL (recepción de mensajes de Meta) ─────────
app.post("/webhook", async (req, res) => {
  // Meta espera una respuesta 200 inmediata, siempre
  res.sendStatus(200);

  const entry   = req.body.entry?.[0];
  const change  = entry?.changes?.[0];
  const value   = change?.value;
  const mensaje = value?.messages?.[0];

  // Si no hay mensaje (puede ser un evento de estado: entregado/leído), ignorar
  if (!mensaje) return;

  // Normalmente viene el teléfono (formato E.164 sin "+", ej: 573001234567). Los clientes que ocultan su número
  // llegan solo con un ID de usuario de WhatsApp (algo como "CO.1234..."), así que se usa el que exista.
  const contacto = value?.contacts?.[0];
  const telefono = mensaje.from || contacto?.wa_id || mensaje.from_user_id || contacto?.user_id || mensaje.user_id;
  if (!telefono) {
    console.error("⚠️ Llegó un mensaje sin teléfono ni ID del cliente. Contenido recibido:", JSON.stringify(req.body).slice(0, 2000));
    return;
  }
  if (!/^\d+$/.test(String(telefono))) {
    console.log(`ℹ️ Cliente identificado por ID de usuario (no mandó su número): ${telefono}`);
  }

  // ── Si el cliente manda una imagen, la tratamos como comprobante de pago ──
  if (mensaje.type === "image") {
    const mediaId = mensaje.image?.id;
    console.log(`🖼️ [${telefono}] imagen recibida (media ${mediaId})`);

    const responder = async (textoUsuario, textoBot) => {
      await guardarMensaje(telefono, "user", textoUsuario);
      await guardarMensaje(telefono, "assistant", textoBot);
      await enviarWhatsApp(telefono, textoBot);
    };

    try {
      // Solo cuenta como comprobante si hay una cita esperando el pago
      const citaId = await obtenerCitaPendiente(telefono);
      if (!citaId) {
        await responder(
          "[El cliente envió una imagen]",
          "Recibí tu imagen 🐾 Si necesitas algo, cuéntame en qué te puedo ayudar o escríbele a nuestro equipo al 314 323 0175."
        );
        return;
      }

      // Revisa que la imagen realmente sea un comprobante de pago
      const analisis = await analizarComprobante(mediaId);
      if (analisis && analisis.es_comprobante === false) {
        await responder(
          "[El cliente envió una imagen que no es un comprobante de pago]",
          "Recibí tu imagen, pero no parece un comprobante de pago 🙏 Para separar tu cupo necesito el pantallazo del pago del anticipo."
        );
        return;
      }

      await procesarComprobante(telefono, mediaId, citaId, analisis?.monto);
      await responder(
        "[El cliente envió una imagen: comprobante de pago]",
        "✅ Recibimos tu comprobante de pago. En cuanto lo verifiquemos, tu cita queda confirmada. ¡Gracias! 🐾"
      );
    } catch (err) {
      console.error("❌ Error procesando imagen:", err);
    }
    return;
  }

  // ── Mensajes que no son texto (audios, videos, documentos, ubicación, etc.) ──
  if (mensaje.type !== "text") {
    console.log(`📎 [${telefono}] mensaje tipo "${mensaje.type}" recibido`);

    // Reacciones con emoji, stickers y avisos del sistema: no se responden
    if (["reaction", "sticker", "unsupported", "system", "request_welcome"].includes(mensaje.type)) return;

    const respuestas = {
      audio: "Por ahora no puedo escuchar audios 🙏 ¿Me escribes tu consulta por aquí? También puedes comunicarte con nuestro equipo al 314 323 0175.",
      video: "Recibí tu video 🐾 Por ahora solo puedo leer mensajes escritos. ¿Me cuentas por escrito en qué te ayudo? También puedes escribir al 314 323 0175.",
      document: "Recibí tu documento 🐾 Si es el comprobante de pago, envíamelo como pantallazo (imagen). Para otras consultas, escríbeme aquí o al 314 323 0175.",
    };
    const textoBot = respuestas[mensaje.type] ||
      "Recibí tu mensaje 🐾 Por ahora solo puedo leer texto. ¿Me cuentas por escrito en qué te ayudo? También puedes escribir al 314 323 0175.";

    try {
      await guardarMensaje(telefono, "user", `[El cliente envió un mensaje de tipo: ${mensaje.type}]`);
      await guardarMensaje(telefono, "assistant", textoBot);
      await enviarWhatsApp(telefono, textoBot);
    } catch (err) {
      console.error("❌ Error respondiendo mensaje no soportado:", err);
    }
    return;
  }

  const body = (mensaje.text?.body || "").trim();

  if (!body) return;

  console.log(`📥 [${telefono}] ${body}`);

  let usuarioGuardado = false;
  try {
    await upsertCliente(telefono);
    const historialPrevio = await getHistorial(telefono);
    const historial = normalizarHistorial([...historialPrevio, { role: "user", content: body }]);

    // Se guarda de una vez: así la conversación aparece en el dashboard aunque Claude falle después
    await guardarMensaje(telefono, "user", body);
    usuarioGuardado = true;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 500,
      system:     SYSTEM_PROMPT + fechaActualTexto() + (await agendaOcupadaTexto()),
      messages:   historial,
    });

    const respuestaOriginal = response.content
      .map(b => b.text || "")
      .join("")
      .trim();

    // Separa la línea interna de datos del texto que ve el cliente
    const extraido = extraerDatosCliente(respuestaOriginal);
    const datosCliente = extraido.datos;
    const mUrg = extraido.texto.match(/\[\[URGENCIA\|([^\]]*)\]\]/);
    const textoBase = extraido.texto.replace(/\[\[URGENCIA\|[^\]]*\]\]/g, "").trim();
    // Si por alguna razón la respuesta quedó vacía, se evita guardar/enviar un mensaje vacío
    let respuesta = textoBase || "Cuéntame un poco más para ayudarte 🐾";
    // La línea "Inicio: AAAA-MM-DD HH:MM" es solo para el calendario: el cliente no la ve
    let respuestaCliente = respuesta.replace(/^[^\n]*Inicio[:\*\s]+\d{4}-\d{2}-\d{2}[^\n]*\n?/gim, "").trim() || respuesta;

    // Última verificación: si el horario se ocupó mientras el cliente decidía, no se confirma la cita
    if ((respuesta.includes("CITA CONFIRMADA") || respuesta.includes("CITA PENDIENTE DE PAGO")) &&
        await hayConflictoCalendario(telefono, respuesta)) {
      respuesta = respuestaCliente = "Ese horario acaba de ocuparse en nuestra agenda 🙏 ¿Me indicas otro día u hora que te sirva?";
    }

    console.log(`📤 [${telefono}] ${respuesta.substring(0, 80)}...`);

    await guardarMensaje(telefono, "assistant", respuestaCliente);

    // Guarda en la tabla clientes lo que Coco aprendió (nombre, mascota, especie, raza)
    if (datosCliente) await upsertCliente(telefono, datosCliente);
    if (mUrg) await registrarUrgencia(telefono, mUrg[1]).catch(e => console.error("⚠️ Urgencia:", e.message));

    if (respuesta.includes("CITA PENDIENTE DE PAGO")) {
      await guardarCita(telefono, respuesta, "pendiente_pago");
    } else if (respuesta.includes("CITA CONFIRMADA")) {
      await guardarCita(telefono, respuesta, "confirmada");

      if (/l[aá]ser|fisio/i.test(respuesta)) {
        const mascota = (respuesta.match(/Mascota[:\*\s]+([^\n\*•]+)/i) || [])[1]?.trim() || null;
        await registrarBano(telefono, mascota);
      }
    }

    await detectarYGuardarCotizacion(telefono, respuesta);

    await enviarWhatsApp(telefono, respuestaCliente);

  } catch (err) {
    console.error("❌ Error en webhook:", err);
    const textoError = "Lo siento, tuve un problema técnico. Por favor escríbenos en unos minutos 🙏 o comunícate con nuestro equipo al 314 323 0175.";
    try {
      if (usuarioGuardado) await guardarMensaje(telefono, "assistant", textoError);
    } catch (_) {}
    try {
      await enviarWhatsApp(telefono, textoError);
    } catch (_) {}
  }
});

// ─── ENDPOINTS ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "Coco — ADIVET 🐾", timestamp: new Date().toISOString() });
});

app.get("/dashboard", async (req, res) => {
  const historialCompleto = req.query.historial === "1"; // para auditar todo el historial
  try {
    const [clientes, citas, cotizaciones, pagos, conversaciones] = await Promise.all([
      pool.query("SELECT * FROM clientes     ORDER BY creado_en DESC LIMIT 100"),
      pool.query("SELECT * FROM citas        ORDER BY creado_en DESC LIMIT 100"),
      pool.query("SELECT * FROM cotizaciones ORDER BY creado_en DESC LIMIT 100"),
      pool.query("SELECT * FROM pagos        ORDER BY creado_en DESC LIMIT 100"),
      historialCompleto
        ? pool.query("SELECT telefono, rol, contenido, creado_en FROM conversaciones ORDER BY creado_en DESC LIMIT 2000")
        : pool.query("SELECT telefono, rol, contenido, creado_en FROM conversaciones WHERE creado_en >= $1 ORDER BY creado_en DESC LIMIT 500", [CONVERSACIONES_DESDE]),
    ]);
    res.json({
      clientes: clientes.rows,
      citas: citas.rows,
      cotizaciones: cotizaciones.rows,
      pagos: pagos.rows,
      conversaciones: conversaciones.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al consultar BD" });
  }
});

// Botón "Verificar" del dashboard: marca el pago como verificado y confirma la cita
app.post("/pagos/:id/verificar", async (req, res) => {
  const pagoId = parseInt(req.params.id, 10);
  if (!Number.isInteger(pagoId)) return res.status(400).json({ error: "ID de pago inválido" });

  try {
    const actual = await pool.query(`SELECT telefono, cita_id, estado FROM pagos WHERE id = $1`, [pagoId]);
    if (actual.rows.length === 0) return res.status(404).json({ error: "Pago no encontrado" });

    const { telefono, estado } = actual.rows[0];
    let citaId = actual.rows[0].cita_id;

    // Si ya estaba verificado (doble clic), no repite el mensaje al cliente
    if (estado === "verificado") return res.json({ ok: true, cita_id: citaId, ya_verificado: true });

    // Si el comprobante llegó sin cita asociada, busca ahora la cita pendiente de ese cliente
    if (!citaId) citaId = await obtenerCitaPendiente(telefono);

    await pool.query(`UPDATE pagos SET estado = 'verificado', cita_id = $2 WHERE id = $1`, [pagoId, citaId]);
    if (citaId) {
      await pool.query(`UPDATE citas SET estado = 'confirmada' WHERE id = $1`, [citaId]);
      sincronizarCalendario(citaId); // el evento pasa de "Pendiente de pago" a confirmado
    }

    // El aviso al cliente no debe romper la verificación si falla el envío
    try {
      const mensaje = citaId
        ? "✅ ¡Listo! Verificamos tu pago y tu cita quedó confirmada. Te esperamos 🐾\n\nSi tienes alguna otra pregunta o necesitas asesoría adicional, puedes escribir directo a nuestro equipo al 314 323 0175."
        : "✅ Verificamos tu pago. Nuestro equipo te confirma enseguida los detalles de tu cita 🐾\n\nSi tienes alguna pregunta, puedes escribir directo al 314 323 0175.";
      await enviarWhatsApp(telefono, mensaje);
    } catch (e) {
      console.error("⚠️ Pago verificado, pero no se pudo avisar al cliente:", e);
    }

    res.json({ ok: true, cita_id: citaId });
  } catch (err) {
    console.error("❌ Error verificando pago:", err);
    res.status(500).json({ error: "Error al verificar el pago" });
  }
});

// ─── RECORDATORIO DE BAÑO CADA 20 DÍAS ─────────────────────────
async function revisarRecordatoriosBano() {
  try {
    const { rows } = await pool.query(
      `SELECT id, telefono, nombre_mascota FROM banos
       WHERE recordatorio_enviado = false
         AND ultimo_bano <= NOW() - INTERVAL '${RECORDATORIO_DIAS} days'`
    );

    for (const r of rows) {
      const nombre = r.nombre_mascota ? r.nombre_mascota : "tu mascota";
      const mensaje = `💙 ¡Hola! Ya pasaron ${RECORDATORIO_DIAS} días desde la última terapia de ${nombre}. ¿Agendamos el control o la siguiente sesión? Escríbeme y te ayudo 🐾`;
      await enviarWhatsApp(r.telefono, mensaje);
      // Reinicia el ciclo: marca como enviado y resetea la fecha para que en 20 días vuelva a avisar
      await pool.query(
        `UPDATE banos SET recordatorio_enviado = true, ultimo_bano = NOW() WHERE id = $1`,
        [r.id]
      );
      console.log(`🛁 Recordatorio de baño enviado a ${r.telefono}`);
    }
  } catch (err) {
    console.error("❌ Error revisando recordatorios de baño:", err);
  }
}

// Al arrancar, comprueba que Google Calendar esté bien conectado y lo deja escrito en los logs
async function verificarGoogleCalendar() {
  if (!GOOGLE_CALENDAR_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) {
    const falta = [!GOOGLE_CALENDAR_ID && "GOOGLE_CALENDAR_ID", !GOOGLE_SERVICE_ACCOUNT_JSON && "GOOGLE_SERVICE_ACCOUNT_JSON"].filter(Boolean).join(" y ");
    console.log(`📅 Google Calendar no está configurado: falta ${falta}`);
    return;
  }
  try {
    if (!leerCredencialesGoogle()) return; // el motivo ya quedó en los logs
    const ahora = new Date();
    const eventos = await listarEventosCalendario(ahora, new Date(ahora.getTime() + 7 * 24 * 3600 * 1000));
    const cupos = eventos.filter(e => SLOT_CONSULTA.test(e.titulo) || SLOT_PELUQUERIA.test(e.titulo)).length;
    console.log(`✅ Google Calendar conectado: ${eventos.length} eventos con hora en los próximos 7 días (${cupos} cupos libres de domicilio o terapia)`);
  } catch (err) {
    console.error("❌ Google Calendar no funciona:", err.message);
  }
}

// ─── ARRANQUE ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 ADIVET Webhook (Meta Cloud API) escuchando en puerto ${PORT}`);
    });
    verificarGoogleCalendar();
    // Revisa recordatorios de baño cada 12 horas
    setInterval(revisarRecordatoriosBano, 12 * 60 * 60 * 1000);
    revisarRecordatoriosBano(); // primera revisión al arrancar
  })
  .catch(err => {
    console.error("❌ No se pudo inicializar la BD:", err);
    process.exit(1);
  });
